# Synthiq image publication

The fork builds images through `.github/workflows/synthiq-image.yml`.
Publication does not deploy the Paperclip server.

The build and publication jobs have separate deadlines.
The publication job permits three 90-minute attempts and time for verification.
Use **Re-run failed jobs** after a publication failure.
This action repeats publication without compilation.
The publication job checks the original image configuration digest and labels before each attempt.
The jobs require the same persistent `paperclip-fork` runner.
A missing image or a different runner stops publication.
Do not rebuild or retag a replacement under an approved version.

For an older failed run, select the release branch in **Run workflow**.
Supply all three existing-image fields:

- `existing_version`: the original version, such as `2026.1012.0-synthiq.19`.
- `existing_revision`: the full original source commit.
- `existing_id`: the original local image configuration digest, including `sha256:`.

This path skips dependency resolution and compilation.
The selected branch must match the image's upstream version.
Use the recorded original configuration digest, not an inferred replacement.
Leave all three fields empty for a new build.
New images and deployment need their normal release approvals.

The publication receipt records the image version, revision, configuration digest, and immutable manifest digest.
The verifier checks the exact manifest bytes and configuration bytes from the registry.
The configuration must name the expected revision, version, and source repository.
The workflow stores `publication.json` as an Actions artifact for 30 days.

The provider pack changes permissions in its build stage.
The final image copies the prepared pack and checks access with an unrelated user.
This order avoids an additional copy of the pack in a permission-change layer.

Run the dependency-free checks with:

```sh
node --test .github/scripts/tests/synthiq-image.test.mjs
```
