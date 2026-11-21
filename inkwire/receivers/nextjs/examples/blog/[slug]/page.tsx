// Renders a published Inkwire "post" at /blog/<slug> with everything SEO Profile 1 asks of a page:
// title, description, canonical, Open Graph, Twitter, robots, BlogPosting JSON-LD, hreflang for its
// translations, and a permanent redirect from the address it had before a slug change.
// Copy it to app/blog/[slug]/page.tsx (src/app/... if you use src/) and set
//   INKWIRE_URL_TEMPLATE={site}/blog/{slug}
// so the addresses the API returns are the ones this page answers on.
import type { Metadata } from "next";
import { notFound, permanentRedirect } from "next/navigation";
import { alternates, effectiveSeo, resolveRedirect } from "inkwire-receiver-core";
import { getInkwire } from "../../api/_inkwire/config";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ slug: string }> };

async function load(slug: string) {
  const { store, keys } = getInkwire();
  const scope = keys[0]?.scope ?? "default";
  const { items } = await store.list(scope, { kind: "post", slug, status: "published", limit: 1 });
  return { entry: items[0] ?? null, store, scope };
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { entry, store, scope } = await load((await params).slug);
  if (!entry) return {};
  const seo = effectiveSeo(entry);
  const url = entry.canonical_url ?? entry.url;
  const images = seo.image_url ? [seo.image_url] : undefined;
  const languages = Object.fromEntries((await alternates(store, scope, entry)).map((a) => [a.lang, a.url]));
  return {
    title: seo.title,
    description: seo.description,
    alternates: { canonical: url, languages },
    robots: seo.noindex ? "noindex,follow" : undefined,
    openGraph: { type: "article", title: seo.title, description: seo.description, url, images, publishedTime: entry.published_at },
    twitter: { card: images ? "summary_large_image" : "summary", title: seo.title, description: seo.description, images },
  };
}

export default async function Post({ params }: Props) {
  const { slug } = await params;
  const { entry, store, scope } = await load(slug);
  if (!entry) {
    // An address the entry had before a slug change: one permanent (308) redirect to where it is now.
    const moved = await resolveRedirect(store, scope, "post", slug);
    if (moved) permanentRedirect(moved.url);
    notFound();
  }
  const seo = effectiveSeo(entry);
  const url = entry.canonical_url ?? entry.url;
  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "BlogPosting",
    headline: seo.title,
    description: seo.description,
    url,
    mainEntityOfPage: url,
    datePublished: entry.published_at,
    ...(seo.image_url ? { image: seo.image_url } : {}),
    ...(entry.author?.name ? { author: { "@type": "Person", name: entry.author.name } } : {}),
    ...(entry.tags?.length ? { keywords: entry.tags } : {}),
  };
  return (
    <article>
      <h1>{entry.title}</h1>
      {/* entry.html is rendered and sanitized by the receiver core */}
      <div dangerouslySetInnerHTML={{ __html: entry.html }} />
      {/* "<" is escaped so caller-controlled text can never close the script element */}
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd).replace(/</g, "\\u003c") }} />
    </article>
  );
}
