import "./globals.css";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "ClubGenAI Classroom",
  description: "Virtual classroom for ClubGenAI sessions",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="fr">
      <body>{children}</body>
    </html>
  );
}
