/**
 * Types for the publish set.
 *
 * Declared for the reason `breaking-coverage.d.mts` gives: a test that imports this untyped needs
 * a `@ts-expect-error`, and suppressing the import turns a typed test of a release gate into an
 * untyped one.
 */

/** One workspace package, as read from its manifest. */
export interface WorkspacePackage {
  readonly dir: string;
  readonly dirName: string;
  readonly manifestPath: string;
  readonly manifest: {
    readonly name: string;
    readonly version: string;
    readonly private?: boolean;
    readonly license?: string;
    readonly files?: readonly string[];
    readonly dependencies?: Readonly<Record<string, string>>;
    readonly repository?: { readonly url?: string };
    readonly publishConfig?: { readonly access?: string };
  };
  readonly name: string;
}

/** Repository root, derived from this file's location rather than the working directory. */
export declare const repoRoot: string;

/** Packages that must never reach the registry, by name. */
export declare const NEVER_PUBLISH: ReadonlySet<string>;

/** The repository every published package must point at, in npm's canonical spelling. */
export declare const REPOSITORY_URL: string;

/** Every workspace package, published or not, in name order. */
export declare function allPackages(): WorkspacePackage[];

/** The packages that are published. */
export declare function publishSet(): WorkspacePackage[];

/** Packages deliberately excluded. */
export declare function excludedPackages(): WorkspacePackage[];

/** Throw if anything that must never publish has reached a set. */
export declare function assertNothingForbidden(packages: readonly WorkspacePackage[]): void;

/** Assert the publish set is actually releasable. */
export declare function assertReleaseReady(packages?: readonly WorkspacePackage[]): {
  ok: boolean;
  problems: string[];
  version: string | undefined;
};
