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
const term = z.string().min(1).max(64);
const jsonLd = z
  .string()
  .min(2)
  .max(20000)
  .refine(
    (v) => {
      try {
        const parsed: unknown = JSON.parse(v);
        const isObject = (x: unknown) => !!x && typeof x === "object" && !Array.isArray(x);
        return Array.isArray(parsed) ? parsed.length > 0 && parsed.every(isObject) : isObject(parsed);
      } catch {
        return false;
      }
    },
    { message: "must be one JSON object, or an array of objects, as a string" },
  );
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
    categories: z.array(term).max(50).optional(),
    cover_image_url: httpUrl.optional(),
    cover_image_alt: z.string().max(1024).optional(),
    canonical_url: httpUrl.optional(),
    seo: z
      .object({
        title: z.string().min(1).max(512).optional(),
        description: z.string().min(1).max(1024).optional(),
        image_url: httpUrl.optional(),
        noindex: z.boolean().optional(),
        og_title: z.string().min(1).max(512).optional(),
        og_description: z.string().min(1).max(1024).optional(),
        json_ld: jsonLd.optional(),
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
    categories: z.array(term).max(50).nullable(),
    cover_image_url: httpUrl.nullable(),
    cover_image_alt: z.string().max(1024).nullable(),
    canonical_url: httpUrl.nullable(),
    seo: z
      .object({
        title: z.string().min(1).max(512),
        description: z.string().min(1).max(1024),
        image_url: httpUrl.nullable(),
        noindex: z.boolean(),
        og_title: z.string().min(1).max(512),
        og_description: z.string().min(1).max(1024),
        json_ld: jsonLd.nullable(),
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

export const MediaPatchSchema = z
  .object({ alt: z.string().max(1024).nullable(), title: z.string().max(512).nullable() })
  .partial()
  .strict()
  .refine((o) => Object.keys(o).length > 0, { message: "at least one field is required" });
export type MediaPatchInput = z.infer<typeof MediaPatchSchema>;
