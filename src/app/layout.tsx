import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Freestrator — editor de archivos .ai",
  description: "Abrí y editá archivos de Adobe Illustrator (.ai) en el navegador.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="es">
      <body>{children}</body>
    </html>
  );
}
