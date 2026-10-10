import { createHash } from 'node:crypto';

// Reviewed ECR-only publication is not an ECS deployment. Keep this exception
// closed to all three reviewed inputs; changing any requires an explicit review
// and refreshed pins, not a filename-only exemption from deployment guards.
const reviewed = {
  '.github/workflows/publish-reviewed-images.yml':
    '40e32f4bac2d5f4e7aace2a9a5221a411bddf1828ab9621967df77c9a774eb51',
  '.github/scripts/publish-reviewed-image.py':
    '4c20fa31ef8bcd5f18e8e894d6fd35157e7bcce1ef9392f70c21cdd6aa86f17e',
  '.github/scripts/reviewed-images.json':
    '2999dad8b1921ad29ad3b30dc2878f009682dbeea16dfe2b75d8b8aee878565a',
};

export function isReviewedImagePublisher(name, workflow, read) {
  if (name !== 'publish-reviewed-images.yml') return false;
  try {
    for (const [file, expected] of Object.entries(reviewed)) {
      if (createHash('sha256').update(read(file)).digest('hex') !== expected) return false;
    }
    if (
      Object.keys(workflow.on ?? {}).join() !== 'workflow_dispatch' ||
      workflow.on.workflow_dispatch.inputs?.expected_source_sha?.required !== true
    )
      return false;
    return Object.values(workflow.jobs ?? {}).every((job) => {
      const guard = 'python3 -B .github/scripts/publish-reviewed-image.py ';
      const runs = (job.steps ?? []).filter((step) => step.run).map((step) => step.run);
      return (
        job['runs-on'] === 'ubuntu-24.04-arm' &&
        job.if.includes("github.event_name == 'workflow_dispatch'") &&
        job.if.includes("github.ref == 'refs/heads/main'") &&
        job.env?.EXPECTED_SOURCE_SHA === '${{ inputs.expected_source_sha }}' &&
        runs.length === 3 &&
        ['guard', 'vacancy', 'verify'].every((phase, i) =>
          runs[i].startsWith(guard + phase + ' --recipe '),
        )
      );
    });
  } catch {
    return false;
  }
}
