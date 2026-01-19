import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Ralphy - Autonomous AI Coding Loop",
  description:
    "Run AI agents on your tasks until done. Supports Claude Code, OpenCode, Codex, Cursor, Qwen-Code and Factory Droid.",
  openGraph: {
    title: "Ralphy - Autonomous AI Coding Loop",
    description:
      "Run AI agents on your tasks until done. Supports Claude Code, OpenCode, Codex, Cursor, Qwen-Code and Factory Droid.",
    type: "website",
  },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className="bg-white text-neutral-800 min-h-screen">{children}</body>
    </html>
  );
}
