/** JSON shared by the build-time generator and the Worker in the same deployment. */
export type DiscoveryIndex = {
  schemaVersion: 1;
  packages: DiscoveryPackage[];
};

export type DiscoveryPackage = {
  id: string;
  lowerId: string;
  registration: string;
  versions: DiscoveryVersion[];
};

export type DiscoveryVersion = {
  version: string;
  lowerVersion: string;
  registrationLeaf: string;
  listed: boolean;
  isPrerelease: boolean;
  isSemVer2: boolean;
  metadata: DiscoveryMetadata;
};

export type DiscoveryMetadata = {
  authors?: string;
  description?: string;
  title?: string;
  summary?: string;
  iconUrl?: string;
  licenseUrl?: string;
  projectUrl?: string;
  tags: string[];
  packageTypes: { name: string; version?: string }[];
};
