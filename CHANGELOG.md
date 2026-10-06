# Changelog

All notable changes to this integration are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[semantic versioning](https://semver.org/), bumped by the Release workflow.

## [Unreleased]

## [1.2.0] - 2026-10-06

### Added

- `SECURITY.md`: how to report a vulnerability.
- `CHANGELOG.md`, rebuilt from the release history.
- `CLAUDE.md`: guide for contributors and coding agents (commands, architecture, invariants).

### Changed

- Development dependencies updated to their latest versions (ESLint 10.12, Prettier 3.9.9, globals 17.13).
- mqtt updated to 5.16.

### Fixed

- Mowers are read on schedule again: devices are published with `should_poll: true`, without which Gladys never polls them, and an integration-owned loop reads the mowers created before that flag. A mower bound on Aliyun (no push) kept its battery, status and progress from startup or from the last command.
- The Release workflow re-runs Prettier on the manifest after `jq`, so a release no longer leaves `main` with a failing CI format check.

## [1.1.4] - 2026-10-06

### Fixed

- Return to dock keeps the job paused, new Stop job button, as in the app

## [1.1.3] - 2026-10-06

### Fixed

- Return to dock ends a job in progress too, not only a paused one

## [1.1.2] - 2026-10-05

### Fixed

- Map vanishing in the Camera widget, return to dock after a pause, zone order

## [1.1.1] - 2026-10-04

### Fixed

- Device page could not save, angle sent the wrong way, zone names, Luba 2 X spacing

## [1.1.0] - 2026-10-04

### Added

- Luba 2 ranges, zone switches, angle type, start progress, job sensors and map

## [1.0.11] - 2026-10-03

### Added

- Mowing settings as drop-down lists on the mower device

### Fixed

- Speed setting could not be saved, dock left a paused job paused

## [1.0.10] - 2026-10-03

### Fixed

- Stop the false "battery under 20% (current: 0%)" alert

## [1.0.9] - 2026-10-02

### Changed

- Mow every zone of the map and use the mowing settings of the configuration

## [1.0.8] - 2026-10-02

### Changed

- Start a real mowing job from Gladys, add a Refresh button, stop disturbing the app

## [1.0.7] - 2026-10-02

### Changed

- Sync the mower before each order, spare the app's report stream, refuse a bare start

## [1.0.6] - 2026-10-01

### Fixed

- Fix ignored commands and slow state on Mammotion-broker mowers

## [1.0.5] - 2026-10-01

### Changed

- Publish the Status text in the 'text' field so Gladys accepts the state batch

## [1.0.4] - 2026-09-30

- Maintenance release, no functional change.

## [1.0.3] - 2026-09-30

### Changed

- Read the state of mowers not bound on Aliyun from the Mammotion MQTT broker

## [1.0.2] - 2026-09-29

### Fixed

- Fix device refused by Gladys: add min/max to the Status text feature

## [1.0.1] - 2026-09-29

### Fixed

- Fix 'invalid poll frequency' when publishing mowers

## [1.0.0] - 2026-09-28

### Fixed

- Fix store rejection: shorten manifest descriptions

## [0.1.1] - 2026-09-27

First public release.

### Added

- Add Mammotion external integration for Gladys
- Add Mammotion cover image

### Changed

- Register Build and Release workflows on main

[Unreleased]: https://github.com/prohand/gladys-mammotion/compare/v1.2.0...HEAD
[1.2.0]: https://github.com/prohand/gladys-mammotion/compare/v1.1.4...v1.2.0
[1.1.4]: https://github.com/prohand/gladys-mammotion/compare/v1.1.3...v1.1.4
[1.1.3]: https://github.com/prohand/gladys-mammotion/compare/v1.1.2...v1.1.3
[1.1.2]: https://github.com/prohand/gladys-mammotion/compare/v1.1.1...v1.1.2
[1.1.1]: https://github.com/prohand/gladys-mammotion/compare/v1.1.0...v1.1.1
[1.1.0]: https://github.com/prohand/gladys-mammotion/compare/v1.0.11...v1.1.0
[1.0.11]: https://github.com/prohand/gladys-mammotion/compare/v1.0.10...v1.0.11
[1.0.10]: https://github.com/prohand/gladys-mammotion/compare/v1.0.9...v1.0.10
[1.0.9]: https://github.com/prohand/gladys-mammotion/compare/v1.0.8...v1.0.9
[1.0.8]: https://github.com/prohand/gladys-mammotion/compare/v1.0.7...v1.0.8
[1.0.7]: https://github.com/prohand/gladys-mammotion/compare/v1.0.6...v1.0.7
[1.0.6]: https://github.com/prohand/gladys-mammotion/compare/v1.0.5...v1.0.6
[1.0.5]: https://github.com/prohand/gladys-mammotion/compare/v1.0.4...v1.0.5
[1.0.4]: https://github.com/prohand/gladys-mammotion/compare/v1.0.3...v1.0.4
[1.0.3]: https://github.com/prohand/gladys-mammotion/compare/v1.0.2...v1.0.3
[1.0.2]: https://github.com/prohand/gladys-mammotion/compare/v1.0.1...v1.0.2
[1.0.1]: https://github.com/prohand/gladys-mammotion/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/prohand/gladys-mammotion/compare/v0.1.1...v1.0.0
[0.1.1]: https://github.com/prohand/gladys-mammotion/releases/tag/v0.1.1
