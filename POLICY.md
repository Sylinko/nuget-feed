# Sylinko NuGet Feed Policy

Every package version is introduced through a pull request to this repository.

Required review facts for each version manifest:

- source repository
- source commit
- release tag
- workflow run URL
- artifact URL
- SHA256

Package binaries remain in the producing repository's GitHub Release. This repository stores manifests, validation logic, feed generation logic, Worker code, and deployment workflows only.

Fork packages should prefer `Sylinko.*` package IDs and `-sylinko.N` prerelease suffixes, for example `1.2.3-sylinko.1`.
