import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "ScheduleFlowTrack",
    short_name: "SFT",
    start_url: "/dashboard",
    display: "standalone",
    background_color: "#f1f5f9",
    theme_color: "#0f172a",
    orientation: "portrait-primary",
    icons: [
      {
        src: "/icon",
        sizes: "192x192",
        type: "image/png",
      },
      {
        src: "/api/icon-512",
        sizes: "512x512",
        type: "image/png",
      },
    ],
  };
}
