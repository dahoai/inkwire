import { z } from "zod";

// Mirrors schema/inkwire-content.schema.json (create) and schema/inkwire-patch.schema.json (patch).
// The JSON schemas are authoritative where they disagree with this file.

const httpUrl = z
  .string()
  .url()
  .refine((u) => /^https?:\/\//.test(u), { message: "must be an http(s) URL" });

const kind = z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/);
const slug = z.string().max(255).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
const publishedAt = z.string().datetime({ offset: true });
const author = z
  .object({ name: z.string().optional(), email: z.string().email().optional() })
  .strict();

export const ContentInput = z
  .object({
    external_id: z.string().min(1).max(255),
    title: z.string().min(1).max(512),
    markdown: z.string().min(1),
    kind: kind.default("post"),
    slug: slug.optional(),
    excerpt: z.string().max(1024).optional(),
    tags: z.array(z.string().max(64)).max(50).optional(),
    cover_image_url: httpUrl.optional(),
    canonical_url: httpUrl.optional(),
    seo: z
      .object({
        title: z.string().min(1).max(512).optional(),
        description: z.string().min(1).max(1024).optional(),
        image_url: httpUrl.optional(),
        noindex: z.boolean().optional(),
      })
      .strict()
      .optional(),
    author: author.optional(),
    status: z.enum(["draft", "published"]).default("draft"),
    published_at: publishedAt.optional(),
  })
  .strict();
export type UpsertInput = z.infer<typeof ContentInput>;

export const PatchSchema = z
  .object({
    title: z.string().min(1).max(512),
    kind,
    markdown: z.string().min(1),
    slug,
    excerpt: z.string().max(1024).nullable(),
    tags: z.array(z.string().max(64)).max(50).nullable(),
    cover_image_url: httpUrl.nullable(),
    canonical_url: httpUrl.nullable(),
    seo: z
      .object({
        title: z.string().min(1).max(512),
        description: z.string().min(1).max(1024),
        image_url: httpUrl.nullable(),
        noindex: z.boolean(),
      })
      .partial()
      .strict()
      .nullable(),
    author: author.nullable(),
    status: z.enum(["draft", "published"]),
    published_at: publishedAt.nullable(),
  })
  .partial()
  .strict()
  .refine((o) => Object.keys(o).length > 0, { message: "at least one field is required" });
export type PatchInput = z.infer<typeof PatchSchema>;

export const MediaUrlInput = z
  .object({ url: httpUrl, alt: z.string().max(1024).optional() })
  .strict();
