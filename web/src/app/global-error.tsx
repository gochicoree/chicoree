"use client";

// Last-resort boundary: replaces the root layout, so it must render its own
// <html> and carry inline styles (globals.css may not have loaded).
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          minHeight: "100dvh",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          fontFamily: "ui-sans-serif, system-ui, sans-serif",
          background: "#f2f5f6",
          color: "#16272f",
          padding: "24px",
          textAlign: "center",
        }}
      >
        <h1 style={{ fontSize: 24, margin: 0 }}>Chicorée hit a fatal error</h1>
        <p style={{ maxWidth: 440, fontSize: 14, lineHeight: 1.6, color: "#5c707b" }}>
          The web interface failed to render. The registry API itself is separate and keeps serving
          pushes and pulls. Reload to try again; if this persists, inspect the web container logs
          {error.digest ? ` and search them for digest ${error.digest}` : ""}.
        </p>
        <button
          onClick={reset}
          style={{
            marginTop: 12,
            padding: "10px 20px",
            borderRadius: 8,
            border: "none",
            background: "#10394c",
            color: "#fff",
            fontWeight: 600,
            cursor: "pointer",
          }}
        >
          Reload
        </button>
      </body>
    </html>
  );
}
