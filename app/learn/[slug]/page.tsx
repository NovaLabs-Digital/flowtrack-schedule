import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { GUIDES, getGuideBySlug, getRelatedGuides, categoryName } from "@/lib/learningCenter";

// All Phase 1 guide slugs are known statically (GUIDES is a fixed, static
// data module, not a database table) -- pre-rendering every guide page at
// build time, same as app/terms and app/privacy's static generation.
export function generateStaticParams() {
  return GUIDES.map((guide) => ({ slug: guide.slug }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const guide = getGuideBySlug(slug);
  if (!guide) {
    return { title: "Guide Not Found — Schedule FlowTrack" };
  }
  return {
    title: `${guide.title} — Schedule FlowTrack Learning Center`,
    description: guide.description,
  };
}

export default async function GuidePage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const guide = getGuideBySlug(slug);
  if (!guide) notFound();

  const related = getRelatedGuides(guide);

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900">
      <nav className="border-b border-slate-200 bg-white">
        <div className="max-w-3xl mx-auto px-6 py-4 flex items-center justify-between">
          <Link href="/" className="flex items-center gap-2.5">
            <div className="flex items-center justify-center w-9 h-9 rounded-lg bg-[#0f172a] text-white text-xs font-bold">
              FTS
            </div>
            <span className="text-sm font-semibold text-slate-900">Schedule FlowTrack</span>
          </Link>
          <Link href="/learn" className="text-xs text-slate-500 hover:text-slate-700 transition-colors">
            ← Back to Learning Center
          </Link>
        </div>
      </nav>

      <main className="max-w-3xl mx-auto px-6 py-12">
        <div className="inline-block rounded-full bg-blue-50 px-3 py-1 text-[11px] font-medium text-blue-700">
          {categoryName(guide.category)}
        </div>
        <h1 className="mt-3 text-2xl font-bold tracking-tight text-slate-900">{guide.title}</h1>
        <p className="mt-3 text-sm text-slate-600 leading-relaxed">{guide.description}</p>

        {/* Video support: nothing renders here at all when neither
            videoId nor videoUrl is set (every Phase 1 guide) -- no empty
            video box. Once a video exists for a guide, it appears here, at
            the top of the guide, with no other page change needed. */}
        {(guide.videoId || guide.videoUrl) && (
          <div className="mt-6">
            {guide.videoId ? (
              <div className="aspect-video w-full overflow-hidden rounded-2xl border border-slate-200 bg-black">
                <iframe
                  src={`https://www.youtube.com/embed/${guide.videoId}`}
                  title={guide.title}
                  className="w-full h-full"
                  allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                  allowFullScreen
                />
              </div>
            ) : (
              <video controls className="w-full rounded-2xl border border-slate-200" src={guide.videoUrl} />
            )}
          </div>
        )}

        <div className="mt-8">
          <h2 className="text-sm font-semibold text-slate-900">Step-by-step</h2>
          <ol className="mt-3 space-y-3 text-sm text-slate-700 leading-relaxed list-decimal list-inside">
            {guide.steps.map((step, i) => (
              <li key={i}>{step}</li>
            ))}
          </ol>
        </div>

        {related.length > 0 && (
          <div className="mt-12 border-t border-slate-200 pt-6">
            <h2 className="text-sm font-semibold text-slate-900">Related guides</h2>
            <div className="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-3">
              {related.map((r) => (
                <Link
                  key={r.slug}
                  href={`/learn/${r.slug}`}
                  className="block rounded-xl border border-slate-200 bg-white p-4 hover:border-slate-300 transition-colors"
                >
                  <div className="text-[11px] font-medium text-blue-700">{categoryName(r.category)}</div>
                  <div className="mt-1 text-sm font-semibold text-slate-900">{r.title}</div>
                  <div className="mt-1 text-xs text-slate-500">{r.description}</div>
                </Link>
              ))}
            </div>
          </div>
        )}
      </main>

      <footer className="border-t border-slate-200 bg-white">
        <div className="max-w-3xl mx-auto px-6 py-6 flex flex-col sm:flex-row items-center justify-between gap-3 text-xs text-slate-500">
          <Link href="/learn" className="hover:text-slate-700 transition-colors">
            ← All guides
          </Link>
          <div className="flex items-center gap-4">
            <Link href="/terms" className="hover:text-slate-700 transition-colors">
              Terms of Service
            </Link>
            <Link href="/privacy" className="hover:text-slate-700 transition-colors">
              Privacy Policy
            </Link>
          </div>
        </div>
      </footer>
    </div>
  );
}
