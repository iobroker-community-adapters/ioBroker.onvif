# Snapshot collision fix — validation and proposed pull request

## Proposed PR

**Title:** Fix concurrent snapshot requests with per-camera single-flight and short cache

Multiple HTTP clients requesting the same camera within 500 ms currently receive
HTTP 500 because `getSnapshot()` returns no image to the second caller. A local
regression test reproduces this on upstream commit
`cdd31c98f51f35644cd5864a89e64e7e482453b1` (expected 200, received 500).

The change shares each camera's pending snapshot promise and reuses a successful,
nonempty buffer within the existing 500 ms window. The window starts when the
fetch starts; a slow fetch does not gain another 500 ms after completion. Pending
requests are shared even beyond that window. Camera objects are WeakMap keys, so
replacing a camera's configuration does not reuse its old image. A change to
`useHighRes` also bypasses the previous entry. Failed or empty results are evicted
immediately; an expired image is never served as a fallback after an error.

Both HTTP authentication paths use a 7-second timeout. FFmpeg work has a
15-second deadline and is killed on timeout or output-stream error, preventing
subsequent clients from joining a permanently stuck request.

Snapshot URLs, HTTP success/error codes, message/state entry points, discovery,
ONVIF events and watchdog behavior retain their existing interfaces. No external
cache, polling service, configuration option or dependency is added. Client
applications and detection algorithms do not need modification.

### Validation

- `npm run test:js`: 14 passing, including eight simultaneous HTTP clients,
  cache expiry at 500 ms, a slow pending fetch, camera isolation, replaced camera
  configuration, Basic/Digest, error recovery, FFmpeg paths and binary JPEG data.
- Regression test on unmodified upstream: fails with `500 !== 200` as expected.
- `npm run lint`: passes.
- `git diff --check`: passes.
- `npm run check`: the same 11 existing upstream diagnostics, compared after
  normalizing shifted line numbers; no additional diagnostics from this change.
- `npm test`: JavaScript tests pass; package tests report 48 passing and two
  failures because the external io-package/JSON-config schemas could not be
  downloaded. This is not a fully green package test run.
- `npm run test:integration`: fails in test setup before adapter startup because
  `@iobroker/db-objects-jsonl` cannot be resolved. Full ioBroker startup integration
  and actual camera operation are not yet confirmed. Camera I/O in the focused tests is simulated; HTTP serving uses the
  adapter's actual server on a local ephemeral port.

### Before opening the upstream PR / production deployment

The production network is not accessible from the development environment.
Installed adapter version, local configuration, transport selection, live
collision reproduction and detector/TV behavior remain to be verified.

1. Record the installed adapter package version, Node version, source checksum,
   `activateServer`, `serverPort` and `useHighRes`. Check whether each device has
   snapshot/major/minor stream URLs without publishing their credentials.
2. Record detector service and timer definitions, current source files, ROI/model
   settings, health wrappers and recent failure logs. Keep backups private.
3. Reproduce a pair of simultaneous HTTP requests to the same camera, recording
   status and timings; correlate with the detector's errors. Repeat for the other
   camera. Do not run an uncontrolled load test.
4. Back up the exact installed adapter/configuration and retain its reinstallable
   version or package. For a customized installation, a version number alone is
   insufficient. Do not replace production files before confirming compatibility
   with this upstream base (including its Node >=22 requirement).
5. Deploy in a controlled window. Keep existing client URLs, detector timing,
   image geometry, model, health notifications and TV-control scripts unchanged.
6. Confirm successful simultaneous requests, image dimensions and freshness,
   both detector outputs and health recovery. Run TV display and both detectors
   together for at least 30 minutes, then observe for several hours. Test both
   cameras and, if used, multiple TV clients. Verify TV on/off behavior separately.
7. If behavior regresses, stop the ONVIF instance, restore the exact backed-up
   adapter/package and configuration, restart it and repeat baseline checks.
   There are no client URL or detector edits to undo for this patch.

The 500 ms cache is deliberately short. It is a request-age limit, not a claim
about a camera's internal exposure timestamp. No capture-time metadata is added
in this minimal patch. A longer configurable cache can be considered separately
if measurements show that it is needed.
