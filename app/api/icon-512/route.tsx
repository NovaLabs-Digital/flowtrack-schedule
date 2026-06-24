import { ImageResponse } from "next/og";

export const runtime = "edge";

export async function GET() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: "#0f172a",
          borderRadius: 96,
          color: "#ffffff",
          fontSize: 170,
          fontWeight: 700,
          letterSpacing: 4,
        }}
      >
        SFT
      </div>
    ),
    { width: 512, height: 512 }
  );
}
