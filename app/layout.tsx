import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Liteverse",
  description: "Map your literature, evidence relationships, and research attention into an explorable 3D knowledge universe.",
  applicationName: "Liteverse",
  icons: {
    icon: "/liteverse-brand.png",
    apple: "/liteverse-brand.png",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
