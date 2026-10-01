export type ArtifactManifest = {
  url?: string;
  sha256?: string;
};

export type PackageManifest = {
  id?: string;
  lowerId?: string;
  source?: {
    repository?: string;
  };
  policy?: {
    requireSylinkoPrefix?: boolean;
    allowOriginalPackageId?: boolean;
  };
};

export type VersionManifest = {
  version?: string;
  lowerVersion?: string;
  listed?: boolean;
  source?: {
    repository?: string;
    commit?: string;
    tag?: string;
    workflowRun?: string;
  };
  artifacts?: {
    nupkg?: ArtifactManifest;
    snupkg?: ArtifactManifest;
    symbols?: ArtifactManifest;
  };
  review?: {
    reason?: string;
  };
};

export type BucketVersionEntry = {
  fileName: string;
  filePath: string;
  manifest: VersionManifest;
};

export type BucketPackageEntry = {
  lowerIdDirectory: string;
  packagePath: string;
  manifest: PackageManifest;
  versions: BucketVersionEntry[];
};

export type Bucket = {
  rootDirectory: string;
  packages: BucketPackageEntry[];
};

export type RequiredArtifactManifest = {
  url: string;
  sha256: string;
};

export type RequiredPackageManifest = {
  id: string;
  lowerId: string;
  source: {
    repository: string;
  };
  policy?: {
    requireSylinkoPrefix?: boolean;
    allowOriginalPackageId?: boolean;
  };
};

export type RequiredVersionManifest = {
  version: string;
  lowerVersion: string;
  listed: boolean;
  source: {
    repository: string;
    commit: string;
    tag: string;
    workflowRun: string;
  };
  artifacts: {
    nupkg: RequiredArtifactManifest;
    snupkg?: RequiredArtifactManifest;
    symbols?: RequiredArtifactManifest;
  };
  review?: {
    reason: string;
  };
};

export type NuspecIdentity = {
  id: string;
  version: string;
};

export type VerifiedRecord = {
  package: RequiredPackageManifest;
  version: RequiredVersionManifest;
  nuspecText: string;
  metadata: PackageMetadata;
  assets: PackageAsset[];
  manifestPath: string;
};

export type DependencyGroup = {
  targetFramework?: string;
  dependencies: { id: string; range?: string }[];
};

export type PackageMetadata = NuspecIdentity & {
  authors?: string;
  description?: string;
  title?: string;
  summary?: string;
  projectUrl?: string;
  licenseUrl?: string;
  licenseExpression?: string;
  iconUrl?: string;
  copyright?: string;
  language?: string;
  releaseNotes?: string;
  minClientVersion?: string;
  requireLicenseAcceptance?: boolean;
  tags: string[];
  packageTypes: { name: string; version?: string }[];
  dependencyGroups: DependencyGroup[];
  iconFile?: string;
  readmeFile?: string;
  licenseFile?: string;
};

export type PackageAsset = {
  name: string;
  content: Buffer;
};
