import type { ReactNode } from "react";
import "./globals.css";

export const metadata = {
  title: "Video KYC customer",
  description: "Customer call shell for the LiveKit room vkyc-${sessionId}",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
