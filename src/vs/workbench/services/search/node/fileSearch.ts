/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as childProcess from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { Readable } from 'stream';
import { NodeStringDecoder, StringDecoder } from 'string_decoder';
import * as arrays from 'vs/base/common/arrays';
import { toErrorMessage } from 'vs/base/common/errorMessage';
import * as glob from 'vs/base/common/glob';
import * as normalization from 'vs/base/common/normalization';
import * as objects from 'vs/base/common/objects';
import { isEqualOrParent } from 'vs/base/common/paths';
import * as platform from 'vs/base/common/platform';
import { StopWatch } from 'vs/base/common/stopwatch';
import * as strings from 'vs/base/common/strings';
import * as types from 'vs/base/common/types';
import { URI } from 'vs/base/common/uri';
import * as extfs from 'vs/base/node/extfs';
import * as flow from 'vs/base/node/flow';
import { IFileQuery, IFolderQuery, IProgress, ISearchEngineStats } from 'vs/platform/search/common/search';
import { IRawFileMatch, ISearchEngine, ISearchEngineSuccess } from 'vs/workbench/services/search/node/search';
import { spawnRipgrepCmd } from './ripgrepFileSearch';

interface IDirectoryEntry {
	base: string;
	relativePath: string;
	basename: string;
}

interface IDirectoryTree {
	rootEntries: IDirectoryEntry[];
	pathToEntries: { [relativePath: string]: IDirectoryEntry[] };
}

const killCmds = new Set<() => void>();
process.on('exit', () => {
	killCmds.forEach(cmd => cmd());
});

export class FileWalker {
	private config: IFileQuery;
	private filePattern: string;
	private normalizedFilePatternLowercase: string;
	private includePattern: glob.ParsedExpression | undefined;
	private maxResults: number | null;
	private exists: boolean;
	private maxFilesize: number | null;
	private isLimitHit: boolean;
	private resultCount: number;
	private isCanceled: boolean;
	private fileWalkSW: StopWatch;
	private directoriesWalked: number;
	private filesWalked: number;
	private errors: string[];
	private cmdSW: StopWatch;
	private cmdResultCount: number;

	private folderExcludePatterns: Map<string, AbsoluteAndRelativeParsedExpression>;
	private globalExcludePattern: glob.ParsedExpression | undefined;

	private walkedPaths: { [path: string]: boolean; };

	constructor(config: IFileQuery) {
		this.config = config;
		this.filePattern = config.filePattern || '';
		this.includePattern = config.includePattern && glob.parse(config.includePattern);
		this.maxResults = config.maxResults || null;
		this.exists = !!config.exists;
		this.walkedPaths = Object.create(null);
		this.resultCount = 0;
		this.isLimitHit = false;
		this.directoriesWalked = 0;
		this.filesWalked = 0;
		this.errors = [];

		if (this.filePattern) {
			this.normalizedFilePatternLowercase = strings.stripWildcards(this.filePattern).toLowerCase();
		}

		this.globalExcludePattern = config.excludePattern && glob.parse(config.excludePattern);
		this.folderExcludePatterns = new Map<string, AbsoluteAndRelativeParsedExpression>();

		config.folderQueries.forEach(folderQuery => {
			const folderExcludeExpression: glob.IExpression = objects.assign({}, folderQuery.excludePattern || {}, this.config.excludePattern || {});

			// Add excludes for other root folders
			const fqPath = folderQuery.folder.fsPath;
			config.folderQueries
				.map(rootFolderQuery => rootFolderQuery.folder.fsPath)
				.filter(rootFolder => rootFolder !== fqPath)
				.forEach(otherRootFolder => {
					// Exclude nested root folders
					if (isEqualOrParent(otherRootFolder, fqPath)) {
						folderExcludeExpression[path.relative(fqPath, otherRootFolder)] = true;
					}
				});

			this.folderExcludePatterns.set(fqPath, new AbsoluteAndRelativeParsedExpression(folderExcludeExpression, fqPath));
		});
	}

	cancel(): void {
		this.isCanceled = true;
	}

	walk(folderQueries: IFolderQuery[], extraFiles: URI[], onResult: (result: IRawFileMatch) => void, onMessage: (message: IProgress) => void, done: (error: Error | null, isLimitHit: boolean) => void): void {
		this.fileWalkSW = StopWatch.create(false);

		// Support that the file pattern is a full path to a file that exists
		if (this.isCanceled) {
			return done(null, this.isLimitHit);
		}

		// For each extra file
		extraFiles.forEach(extraFilePath => {
			const basename = path.basename(extraFilePath.fsPath);
			if (this.globalExcludePattern && this.globalExcludePattern(extraFilePath.fsPath, basename)) {
				return; // excluded
			}

			// File: Check for match on file pattern and include pattern
			this.matchFile(onResult, { relativePath: extraFilePath.fsPath /* no workspace relative path */, basename });
		});

		this.cmdSW = StopWatch.create(false);

		// For each root folder
		flow.parallel<IFolderQuery, void>(folderQueries, (folderQuery: IFolderQuery, rootFolderDone: (err: Error | null, result: void) => void) => {
			this.call(this.cmdTraversal, this, folderQuery, onResult, onMessage, (err?: Error) => {
				if (err) {
					const errorMessage = toErrorMessage(err);
					console.error(errorMessage);
					this.errors.push(errorMessage);
					rootFolderDone(err, undefined);
				} else {
					rootFolderDone(null, undefined);
				}
			});
		}, (errors, result) => {
			this.fileWalkSW.stop();
			const err = errors ? arrays.coalesce(errors)[0] : null;
			done(err, this.isLimitHit);
		});
	}

	private call<F extends Function>(fun: F, that: any, ...args: any[]): void {
		try {
			fun.apply(that, args);
		} catch (e) {
			args[args.length - 1](e);
		}
	}

	private cmdTraversal(folderQuery: IFolderQuery, onResult: (result: IRawFileMatch) => void, onMessage: (message: IProgress) => void, cb: (err?: Error) => void): void {
		const rootFolder = folderQuery.folder.fsPath;
		const isMac = platform.isMacintosh;
		let cmd: childProcess.ChildProcess;
		const killCmd = () => cmd && cmd.kill();
		killCmds.add(killCmd);

		let done = (err?: Error) => {
			killCmds.delete(killCmd);
			done = () => { };
			cb(err);
		};
		let leftover = '';
		const tree = this.initDirectoryTree();

		let noSiblingsClauses: boolean;
		const ripgrep = spawnRipgrepCmd(this.config, folderQuery, this.config.includePattern, this.folderExcludePatterns.get(folderQuery.folder.fsPath)!.expression);
		cmd = ripgrep.cmd;
		noSiblingsClauses = !Object.keys(ripgrep.siblingClauses).length;

		const escapedArgs = ripgrep.rgArgs.args
			.map(arg => arg.match(/^-/) ? arg : `'${arg}'`)
			.join(' ');

		let rgCmd = `rg ${escapedArgs}\n - cwd: ${ripgrep.cwd}`;
		if (ripgrep.rgArgs.siblingClauses) {
			rgCmd += `\n - Sibling clauses: ${JSON.stringify(ripgrep.rgArgs.siblingClauses)}`;
		}
		onMessage({ message: rgCmd });

		this.cmdResultCount = 0;
		this.collectStdout(cmd, 'utf8', onMessage, (err: Error, stdout?: string, last?: boolean) => {
			if (err) {
				done(err);
				return;
			}
			if (this.isLimitHit) {
				done();
				return;
			}

			// Mac: uses NFD unicode form on disk, but we want NFC
			const normalized = leftover + (isMac ? normalization.normalizeNFC(stdout || '') : stdout);
			const relativeFiles = normalized.split('\n');

			if (last) {
				const n = relativeFiles.length;
				relativeFiles[n - 1] = relativeFiles[n - 1].trim();
				if (!relativeFiles[n - 1]) {
					relativeFiles.pop();
				}
			} else {
				leftover = relativeFiles.pop() || '';
			}

			if (relativeFiles.length && relativeFiles[0].indexOf('\n') !== -1) {
				done(new Error('Splitting up files failed'));
				return;
			}

			this.cmdResultCount += relativeFiles.length;

			if (noSiblingsClauses) {
				for (const relativePath of relativeFiles) {
					const basename = path.basename(relativePath);
					this.matchFile(onResult, { base: rootFolder, relativePath, basename });
					if (this.isLimitHit) {
						killCmd();
						break;
					}
				}
				if (last || this.isLimitHit) {
					done();
				}

				return;
			}

			// TODO: Optimize siblings clauses with ripgrep here.
			this.addDirectoryEntries(tree, rootFolder, relativeFiles, onResult);

			if (last) {
				this.matchDirectoryTree(tree, rootFolder, onResult);
				done();
			}
		});
	}

	/**
	 * Public for testing.
	 */
	spawnFindCmd(folderQuery: IFolderQuery) {
		const excludePattern = this.folderExcludePatterns.get(folderQuery.folder.fsPath)!;
		const basenames = excludePattern.getBasenameTerms();
		const pathTerms = excludePattern.getPathTerms();
		const args = ['-L', '.'];
		if (basenames.length || pathTerms.length) {
			args.push('-not', '(', '(');
			for (const basename of basenames) {
				args.push('-name', basename);
				args.push('-o');
			}
			for (const path of pathTerms) {
				args.push('-path', path);
				args.push('-o');
			}
			args.pop();
			args.push(')', '-prune', ')');
		}
		args.push('-type', 'f');
		return childProcess.spawn('find', args, { cwd: folderQuery.folder.fsPath });
	}

	/**
	 * Public for testing.
	 */
	readStdout(cmd: childProcess.ChildProcess, encoding: string, cb: (err: Error | null, stdout?: string) => void): void {
		let all = '';
		this.collectStdout(cmd, encoding, () => { }, (err: Error, stdout?: string, last?: boolean) => {
			if (err) {
				cb(err);
				return;
			}

			all += stdout;
			if (last) {
				cb(null, all);
			}
		});
	}

	private collectStdout(cmd: childProcess.ChildProcess, encoding: string, onMessage: (message: IProgress) => void, cb: (err: Error | null, stdout?: string, last?: boolean) => void): void {
		let onData = (err: Error | null, stdout?: string, last?: boolean) => {
			if (err || last) {
				onData = () => { };

				if (this.cmdSW) {
					this.cmdSW.stop();
				}
			}
			cb(err, stdout, last);
		};

		let gotData = false;
		if (cmd.stdout) {
			// Should be non-null, but #38195
			this.forwardData(cmd.stdout, encoding, onData);
			cmd.stdout.once('data', () => gotData = true);
		} else {
			onMessage({ message: 'stdout is null' });
		}

		let stderr: Buffer[];
		if (cmd.stderr) {
			// Should be non-null, but #38195
			stderr = this.collectData(cmd.stderr);
		} else {
			onMessage({ message: 'stderr is null' });
		}

		cmd.on('error', (err: Error) => {
			onData(err);
		});

		cmd.on('close', (code: number) => {
			// ripgrep returns code=1 when no results are found
			let stderrText: string;
			if (!gotData && (stderrText = this.decodeData(stderr, encoding)) && rgErrorMsgForDisplay(stderrText)) {
				onData(new Error(`command failed with error code ${code}: ${this.decodeData(stderr, encoding)}`));
			} else {
				if (this.exists && code === 0) {
					this.isLimitHit = true;
				}
				onData(null, '', true);
			}
		});
	}

	private forwardData(stream: Readable, encoding: string, cb: (err: Error | null, stdout?: string) => void): NodeStringDecoder {
		const decoder = new StringDecoder(encoding);
		stream.on('data', (data: Buffer) => {
			cb(null, decoder.write(data));
		});
		return decoder;
	}

	private collectData(stream: Readable): Buffer[] {
		const buffers: Buffer[] = [];
		stream.on('data', (data: Buffer) => {
			buffers.push(data);
		});
		return buffers;
	}

	private decodeData(buffers: Buffer[], encoding: string): string {
		const decoder = new StringDecoder(encoding);
		return buffers.map(buffer => decoder.write(buffer)).join('');
	}

	private initDirectoryTree(): IDirectoryTree {
		const tree: IDirectoryTree = {
			rootEntries: [],
			pathToEntries: Object.create(null)
		};
		tree.pathToEntries['.'] = tree.rootEntries;
		return tree;
	}

	private addDirectoryEntries({ pathToEntries }: IDirectoryTree, base: string, relativeFiles: string[], onResult: (result: IRawFileMatch) => void) {
		// Support relative paths to files from a root resource (ignores excludes)
		if (relativeFiles.indexOf(this.filePattern) !== -1) {
			const basename = path.basename(this.filePattern);
			this.matchFile(onResult, { base: base, relativePath: this.filePattern, basename });
		}

		function add(relativePath: string) {
			const basename = path.basename(relativePath);
			const dirname = path.dirname(relativePath);
			let entries = pathToEntries[dirname];
			if (!entries) {
				entries = pathToEntries[dirname] = [];
				add(dirname);
			}
			entries.push({
				base,
				relativePath,
				basename
			});
		}
		relativeFiles.forEach(add);
	}

	private matchDirectoryTree({ rootEntries, pathToEntries }: IDirectoryTree, rootFolder: string, onResult: (result: IRawFileMatch) => void) {
		const self = this;
		const excludePattern = this.folderExcludePatterns.get(rootFolder)!;
		const filePattern = this.filePattern;
		function matchDirectory(entries: IDirectoryEntry[]) {
			self.directoriesWalked++;
			const hasSibling = glob.hasSiblingFn(() => entries.map(entry => entry.basename));
			for (let i = 0, n = entries.length; i < n; i++) {
				const entry = entries[i];
				const { relativePath, basename } = entry;

				// Check exclude pattern
				// If the user searches for the exact file name, we adjust the glob matching
				// to ignore filtering by siblings because the user seems to know what she
				// is searching for and we want to include the result in that case anyway
				if (excludePattern.test(relativePath, basename, filePattern !== basename ? hasSibling : undefined)) {
					continue;
				}

				const sub = pathToEntries[relativePath];
				if (sub) {
					matchDirectory(sub);
				} else {
					self.filesWalked++;
					if (relativePath === filePattern) {
						continue; // ignore file if its path matches with the file pattern because that is already matched above
					}

					self.matchFile(onResult, entry);
				}

				if (self.isLimitHit) {
					break;
				}
			}
		}
		matchDirectory(rootEntries);
	}

	getStats(): ISearchEngineStats {
		return {
			cmdTime: this.cmdSW && this.cmdSW.elapsed(),
			fileWalkTime: this.fileWalkSW.elapsed(),
			directoriesWalked: this.directoriesWalked,
			filesWalked: this.filesWalked,
			cmdResultCount: this.cmdResultCount
		};
	}

	private doWalk(folderQuery: IFolderQuery, relativeParentPath: string, files: string[], onResult: (result: IRawFileMatch) => void, done: (error?: Error) => void): void {
		const rootFolder = folderQuery.folder;

		// Execute tasks on each file in parallel to optimize throughput
		const hasSibling = glob.hasSiblingFn(() => files);
		flow.parallel(files, (file: string, clb: (error: Error | null, _?: any) => void): void => {

			// Check canceled
			if (this.isCanceled || this.isLimitHit) {
				return clb(null);
			}

			// Check exclude pattern
			// If the user searches for the exact file name, we adjust the glob matching
			// to ignore filtering by siblings because the user seems to know what she
			// is searching for and we want to include the result in that case anyway
			const currentRelativePath = relativeParentPath ? [relativeParentPath, file].join(path.sep) : file;
			if (this.folderExcludePatterns.get(folderQuery.folder.fsPath)!.test(currentRelativePath, file, this.config.filePattern !== file ? hasSibling : undefined)) {
				return clb(null);
			}

			// Use lstat to detect links
			const currentAbsolutePath = [rootFolder.fsPath, currentRelativePath].join(path.sep);
			fs.lstat(currentAbsolutePath, (error, lstat) => {
				if (error || this.isCanceled || this.isLimitHit) {
					return clb(null);
				}

				// If the path is a link, we must instead use fs.stat() to find out if the
				// link is a directory or not because lstat will always return the stat of
				// the link which is always a file.
				this.statLinkIfNeeded(currentAbsolutePath, lstat, (error, stat) => {
					if (error || this.isCanceled || this.isLimitHit) {
						return clb(null);
					}

					// Directory: Follow directories
					if (stat.isDirectory()) {
						this.directoriesWalked++;

						// to really prevent loops with links we need to resolve the real path of them
						return this.realPathIfNeeded(currentAbsolutePath, lstat, (error, realpath) => {
							if (error || this.isCanceled || this.isLimitHit) {
								return clb(null);
							}

							realpath = realpath || '';
							if (this.walkedPaths[realpath]) {
								return clb(null); // escape when there are cycles (can happen with symlinks)
							}

							this.walkedPaths[realpath] = true; // remember as walked

							// Continue walking
							return extfs.readdir(currentAbsolutePath, (error: Error, children: string[]): void => {
								if (error || this.isCanceled || this.isLimitHit) {
									return clb(null);
								}

								this.doWalk(folderQuery, currentRelativePath, children, onResult, err => clb(err || null));
							});
						});
					}

					// File: Check for match on file pattern and include pattern
					else {
						this.filesWalked++;
						if (currentRelativePath === this.filePattern) {
							return clb(null, undefined); // ignore file if its path matches with the file pattern because checkFilePatternRelativeMatch() takes care of those
						}

						if (this.maxFilesize && types.isNumber(stat.size) && stat.size > this.maxFilesize) {
							return clb(null, undefined); // ignore file if max file size is hit
						}

						this.matchFile(onResult, { base: rootFolder.fsPath, relativePath: currentRelativePath, basename: file, size: stat.size });
					}

					// Unwind
					return clb(null, undefined);
				});
			});
		}, (error: Error[]): void => {
			if (error) {
				error = arrays.coalesce(error); // find any error by removing null values first
			}

			return done(error && error.length > 0 ? error[0] : undefined);
		});
	}

	private matchFile(onResult: (result: IRawFileMatch) => void, candidate: IRawFileMatch): void {
		if (this.isFilePatternMatch(candidate.relativePath) && (!this.includePattern || this.includePattern(candidate.relativePath, candidate.basename))) {
			this.resultCount++;

			if (this.exists || (this.maxResults && this.resultCount > this.maxResults)) {
				this.isLimitHit = true;
			}

			if (!this.isLimitHit) {
				onResult(candidate);
			}
		}
	}

	private isFilePatternMatch(path: string): boolean {

		// Check for search pattern
		if (this.filePattern) {
			if (this.filePattern === '*') {
				return true; // support the all-matching wildcard
			}

			return strings.fuzzyContains(path, this.normalizedFilePatternLowercase);
		}

		// No patterns means we match all
		return true;
	}

	private statLinkIfNeeded(path: string, lstat: fs.Stats, clb: (error: Error | null, stat: fs.Stats) => void): void {
		if (lstat.isSymbolicLink()) {
			return fs.stat(path, clb); // stat the target the link points to
		}

		return clb(null, lstat); // not a link, so the stat is already ok for us
	}

	private realPathIfNeeded(path: string, lstat: fs.Stats, clb: (error: Error | null, realpath?: string) => void): void {
		if (lstat.isSymbolicLink()) {
			return fs.realpath(path, (error, realpath) => {
				if (error) {
					return clb(error);
				}

				return clb(null, realpath);
			});
		}

		return clb(null, path);
	}
}

export class Engine implements ISearchEngine<IRawFileMatch> {
	private folderQueries: IFolderQuery[];
	private extraFiles: URI[];
	private walker: FileWalker;

	constructor(config: IFileQuery) {
		this.folderQueries = config.folderQueries;
		this.extraFiles = config.extraFileResources || [];

		this.walker = new FileWalker(config);
	}

	search(onResult: (result: IRawFileMatch) => void, onProgress: (progress: IProgress) => void, done: (error: Error, complete: ISearchEngineSuccess) => void): void {
		this.walker.walk(this.folderQueries, this.extraFiles, onResult, onProgress, (err: Error, isLimitHit: boolean) => {
			done(err, {
				limitHit: isLimitHit,
				stats: this.walker.getStats()
			});
		});
	}

	cancel(): void {
		this.walker.cancel();
	}
}

/**
 * This class exists to provide one interface on top of two ParsedExpressions, one for absolute expressions and one for relative expressions.
 * The absolute and relative expressions don't "have" to be kept separate, but this keeps us from having to path.join every single
 * file searched, it's only used for a text search with a searchPath
 */
class AbsoluteAndRelativeParsedExpression {
	private absoluteParsedExpr: glob.ParsedExpression | undefined;
	private relativeParsedExpr: glob.ParsedExpression | undefined;

	constructor(public expression: glob.IExpression, private root: string) {
		this.init(expression);
	}

	/**
	 * Split the IExpression into its absolute and relative components, and glob.parse them separately.
	 */
	private init(expr: glob.IExpression): void {
		let absoluteGlobExpr: glob.IExpression | undefined;
		let relativeGlobExpr: glob.IExpression | undefined;
		Object.keys(expr)
			.filter(key => expr[key])
			.forEach(key => {
				if (path.isAbsolute(key)) {
					absoluteGlobExpr = absoluteGlobExpr || glob.getEmptyExpression();
					absoluteGlobExpr[key] = expr[key];
				} else {
					relativeGlobExpr = relativeGlobExpr || glob.getEmptyExpression();
					relativeGlobExpr[key] = expr[key];
				}
			});

		this.absoluteParsedExpr = absoluteGlobExpr && glob.parse(absoluteGlobExpr, { trimForExclusions: true });
		this.relativeParsedExpr = relativeGlobExpr && glob.parse(relativeGlobExpr, { trimForExclusions: true });
	}

	test(_path: string, basename?: string, hasSibling?: (name: string) => boolean | Promise<boolean>): string | Promise<string | null> | undefined | null {
		return (this.relativeParsedExpr && this.relativeParsedExpr(_path, basename, hasSibling)) ||
			(this.absoluteParsedExpr && this.absoluteParsedExpr(path.join(this.root, _path), basename, hasSibling));
	}

	getBasenameTerms(): string[] {
		const basenameTerms: string[] = [];
		if (this.absoluteParsedExpr) {
			basenameTerms.push(...glob.getBasenameTerms(this.absoluteParsedExpr));
		}

		if (this.relativeParsedExpr) {
			basenameTerms.push(...glob.getBasenameTerms(this.relativeParsedExpr));
		}

		return basenameTerms;
	}

	getPathTerms(): string[] {
		const pathTerms: string[] = [];
		if (this.absoluteParsedExpr) {
			pathTerms.push(...glob.getPathTerms(this.absoluteParsedExpr));
		}

		if (this.relativeParsedExpr) {
			pathTerms.push(...glob.getPathTerms(this.relativeParsedExpr));
		}

		return pathTerms;
	}
}

export function rgErrorMsgForDisplay(msg: string): string | undefined {
	const lines = msg.trim().split('\n');
	const firstLine = lines[0].trim();

	if (strings.startsWith(firstLine, 'Error parsing regex')) {
		return firstLine;
	}

	if (strings.startsWith(firstLine, 'regex parse error')) {
		return strings.uppercaseFirstLetter(lines[lines.length - 1].trim());
	}

	if (strings.startsWith(firstLine, 'error parsing glob') ||
		strings.startsWith(firstLine, 'unsupported encoding')) {
		// Uppercase first letter
		return firstLine.charAt(0).toUpperCase() + firstLine.substr(1);
	}

	if (firstLine === `Literal '\\n' not allowed.`) {
		// I won't localize this because none of the Ripgrep error messages are localized
		return `Literal '\\n' currently not supported`;
	}

	if (strings.startsWith(firstLine, 'Literal ')) {
		// Other unsupported chars
		return firstLine;
	}

	return undefined;
}
