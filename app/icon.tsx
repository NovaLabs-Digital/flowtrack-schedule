import { ImageResponse } from "next/og";

export const size = { width: 192, height: 192 };
export const contentType = "image/png";

export default function Icon() {
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
          borderRadius: 36,
          color: "#ffffff",
          fontSize: 64,
          fontWeight: 700,
          letterSpacing: 2,
        }}
      >
        SFT
      </div>
    ),
    { ...size }
  );
}
