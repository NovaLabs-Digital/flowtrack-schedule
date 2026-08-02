import Script from "next/script";

// GA4 (gtag.js) -- the single Google tag for the whole app, rendered once
// from the root layout (app/layout.tsx) so every route inherits it, never
// duplicated per-route. Renders nothing at all -- not even an empty/inert
// script tag -- when NEXT_PUBLIC_GA_MEASUREMENT_ID isn't set (local dev,
// or any deployment environment where the variable hasn't been configured
// yet), so there is never a broken gtag() call with an undefined id.
//
// Both <Script> tags use Next.js's "afterInteractive" strategy: injected
// after the page has hydrated, so analytics loading never blocks or delays
// the initial render -- the officially recommended approach for
// third-party scripts like gtag.js in the App Router (see
// https://nextjs.org/docs/app/api-reference/components/script).
//
// The measurement ID is read once, from the one environment variable this
// integration is scoped to -- never hardcoded here or anywhere else in the
// app. This is GA4's stock automatic-page-view + enhanced-measurement
// setup only; no custom event (signup, trial, Stripe, conversion, etc.) is
// sent from here or anywhere else.
export default function GoogleAnalytics() {
  const measurementId = process.env.NEXT_PUBLIC_GA_MEASUREMENT_ID;
  if (!measurementId) return null;

  return (
    <>
      <Script
        src={`https://www.googletagmanager.com/gtag/js?id=${measurementId}`}
        strategy="afterInteractive"
      />
      <Script id="ga4-init" strategy="afterInteractive">
        {`
          window.dataLayer = window.dataLayer || [];
          function gtag(){dataLayer.push(arguments);}
          gtag('js', new Date());
          gtag('config', '${measurementId}');
        `}
      </Script>
    </>
  );
}
