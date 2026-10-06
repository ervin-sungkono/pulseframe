import type { Metadata } from "next";
import "./globals.css";
import "./quick-looks.css";

export const metadata: Metadata = {
  title: "Pulseframe — Music Visualizer Studio",
  description: "Create audio-reactive visuals with particle effects from your own music or video, then export a shareable video.",
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className="antialiased">{children}</body>
    </html>
  );
}
