import { z } from "zod/v4";
import {
  MENTION_JOB_APPLICATION_STATUSES,
  MENTION_JOB_EMPLOYMENT_TYPES,
  MENTION_JOB_SALARY_INTERVALS,
  MENTION_JOB_STATUSES,
  MENTION_JOB_WORKPLACE_TYPES,
  type MentionJobApplication,
  type MentionJobPosting,
} from "@mention/shared-types";
import { api, formatApiError } from "../lib/api-client.js";
import { withAuthGuard } from "../lib/auth-guard.js";
import type { MentionToolRegistrar } from "../lib/tool-registry.js";

const locationInputSchema = z.object({
  raw: z.string().describe("Free-text location as the employer entered it"),
  countryCode: z.string().optional(),
  region: z.string().optional(),
  city: z.string().optional(),
});

const salaryInputSchema = z.object({
  min: z.number().optional(),
  max: z.number().optional(),
  currency: z.string().describe("ISO 4217 currency code"),
  interval: z.enum(MENTION_JOB_SALARY_INTERVALS),
});

const applicationModeSchema = z.enum(["mention", "external"]);

/**
 * Formats a Mention job posting into a compact, LLM-friendly summary.
 */
function formatJob(job: MentionJobPosting): string {
  const id = job.id || "unknown";
  const status = job.status || "draft";
  const location = job.location?.raw ? ` — ${job.location.raw}` : "";
  const workplace = job.workplaceType ? ` (${job.workplaceType})` : "";
  const employment = job.employmentType ? ` [${job.employmentType}]` : "";
  const salary = job.salary
    ? `\n  Salary: ${[job.salary.min, job.salary.max].filter((v) => v !== undefined).join("–")} ${job.salary.currency}/${job.salary.interval}`
    : "";
  const applyMode =
    job.applicationMode === "external"
      ? `\n  Apply externally: ${job.externalApplyUrl ?? "(no URL set)"}`
      : `\n  Applications: ${job.applicationCount ?? 0}`;
  const url = job.canonicalUrl ? `\n  URL: ${job.canonicalUrl}` : "";

  return `[${id}] ${job.title}${location}${workplace}${employment} — ${status}${salary}${applyMode}${url}`;
}

function formatApplication(application: MentionJobApplication): string {
  const id = application.id || "unknown";
  const status = application.status || "new";
  const name = application.displayName ? ` ${application.displayName}` : "";
  const contact = application.contactMethod ? `\n  Contact: ${application.contactMethod}` : "";
  const cover = application.coverNote ? `\n  Note: ${application.coverNote}` : "";
  const resume = application.resumeFileId ? `\n  Resume: ${application.resumeFileId}` : "";

  return `[${id}]${name} — ${status}${contact}${cover}${resume}`;
}

export function registerJobsTools(server: MentionToolRegistrar): void {
  server.tool(
    "create-job",
    "Create a Mention job listing for an organization/project account you operate (requires authorization).",
    {
      employerOxyUserId: z.string().describe("The organization/project Oxy account this job is published under"),
      title: z.string(),
      description: z.string(),
      location: locationInputSchema.optional(),
      workplaceType: z.enum(MENTION_JOB_WORKPLACE_TYPES).optional(),
      employmentType: z.enum(MENTION_JOB_EMPLOYMENT_TYPES).optional(),
      salary: salaryInputSchema.optional(),
      skills: z.array(z.string()).optional(),
      applicationMode: applicationModeSchema,
      externalApplyUrl: z.string().optional().describe("Required when applicationMode is 'external'"),
      publish: z.boolean().optional().describe("Publish immediately instead of saving a draft. Defaults to false."),
    },
    withAuthGuard(async (args) => {
      try {
        const result = await api.post("/jobs", args);
        return {
          content: [{ type: "text" as const, text: `Job created.\n\n${formatJob(result as MentionJobPosting)}` }],
        };
      } catch (error) {
        return { content: [{ type: "text" as const, text: formatApiError(error) }], isError: true };
      }
    }),
  );

  server.tool(
    "update-job",
    "Update a Mention job listing's fields (requires authorization).",
    {
      id: z.string(),
      title: z.string().optional(),
      description: z.string().optional(),
      location: locationInputSchema.optional(),
      workplaceType: z.enum(MENTION_JOB_WORKPLACE_TYPES).optional(),
      employmentType: z.enum(MENTION_JOB_EMPLOYMENT_TYPES).optional(),
      salary: salaryInputSchema.optional(),
      skills: z.array(z.string()).optional(),
      applicationMode: applicationModeSchema.optional(),
      externalApplyUrl: z.string().optional(),
    },
    withAuthGuard(async ({ id, ...body }) => {
      try {
        const result = await api.put(`/jobs/${encodeURIComponent(id)}`, body);
        return {
          content: [{ type: "text" as const, text: `Job updated.\n\n${formatJob(result as MentionJobPosting)}` }],
        };
      } catch (error) {
        return { content: [{ type: "text" as const, text: formatApiError(error) }], isError: true };
      }
    }),
  );

  server.tool(
    "publish-job",
    "Publish a draft or paused Mention job listing, making it publicly visible (requires authorization).",
    { id: z.string() },
    withAuthGuard(async ({ id }) => {
      try {
        const result = await api.post(`/jobs/${encodeURIComponent(id)}/publish`);
        return {
          content: [{ type: "text" as const, text: `Job published.\n\n${formatJob(result as MentionJobPosting)}` }],
        };
      } catch (error) {
        return { content: [{ type: "text" as const, text: formatApiError(error) }], isError: true };
      }
    }),
  );

  server.tool(
    "pause-job",
    "Pause a published Mention job listing, hiding it from discovery without closing it (requires authorization).",
    { id: z.string() },
    withAuthGuard(async ({ id }) => {
      try {
        const result = await api.post(`/jobs/${encodeURIComponent(id)}/pause`);
        return {
          content: [{ type: "text" as const, text: `Job paused.\n\n${formatJob(result as MentionJobPosting)}` }],
        };
      } catch (error) {
        return { content: [{ type: "text" as const, text: formatApiError(error) }], isError: true };
      }
    }),
  );

  server.tool(
    "close-job",
    "Close a Mention job listing permanently (requires authorization). This cannot be undone.",
    { id: z.string() },
    withAuthGuard(async ({ id }) => {
      try {
        const result = await api.post(`/jobs/${encodeURIComponent(id)}/close`);
        return {
          content: [{ type: "text" as const, text: `Job closed.\n\n${formatJob(result as MentionJobPosting)}` }],
        };
      } catch (error) {
        return { content: [{ type: "text" as const, text: formatApiError(error) }], isError: true };
      }
    }),
  );

  server.tool(
    "list-my-jobs",
    "List Mention job postings across every organization/project account you operate (requires authorization).",
    {
      status: z.enum(MENTION_JOB_STATUSES).optional(),
      limit: z.number().optional(),
    },
    withAuthGuard(async ({ status, limit }) => {
      try {
        const query: Record<string, string | number | boolean | undefined> = {};
        if (status) query.status = status;
        if (limit) query.limit = limit;

        const result = await api.get("/jobs/mine", query);
        const jobs = Array.isArray((result as Record<string, unknown>).jobs)
          ? ((result as Record<string, unknown>).jobs as MentionJobPosting[])
          : [];
        if (jobs.length === 0) {
          return { content: [{ type: "text" as const, text: "No jobs found." }] };
        }
        const formatted = jobs.map((job) => formatJob(job)).join("\n\n");
        return { content: [{ type: "text" as const, text: `Jobs (${jobs.length}):\n\n${formatted}` }] };
      } catch (error) {
        return { content: [{ type: "text" as const, text: formatApiError(error) }], isError: true };
      }
    }),
  );

  server.tool(
    "get-job-applications",
    "Get applications submitted to one of your Mention job listings (requires authorization).",
    {
      id: z.string(),
      status: z.enum(MENTION_JOB_APPLICATION_STATUSES).optional(),
      limit: z.number().optional(),
    },
    withAuthGuard(async ({ id, status, limit }) => {
      try {
        const query: Record<string, string | number | boolean | undefined> = {};
        if (status) query.status = status;
        if (limit) query.limit = limit;

        const result = await api.get(`/jobs/${encodeURIComponent(id)}/applications`, query);
        const applications = Array.isArray((result as Record<string, unknown>).applications)
          ? ((result as Record<string, unknown>).applications as MentionJobApplication[])
          : [];
        if (applications.length === 0) {
          return { content: [{ type: "text" as const, text: "No applications found." }] };
        }
        const formatted = applications.map((application) => formatApplication(application)).join("\n\n");
        return {
          content: [{ type: "text" as const, text: `Applications (${applications.length}):\n\n${formatted}` }],
        };
      } catch (error) {
        return { content: [{ type: "text" as const, text: formatApiError(error) }], isError: true };
      }
    }),
  );
}
