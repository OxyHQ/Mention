import LocaleProvider from "./LocaleProvider";
import { Analytics } from "@vercel/analytics/react";
import { SpeedInsights } from "@vercel/speed-insights/next";
import type { Metadata } from "next";
import type { Viewport } from "next";
import { cookies } from "next/headers";
import { AxiomWebVitals } from "next-axiom";

import "./styles/layout.scss";
import "./styles/tailwind.css";
import { Toaster } from "@/components/ui/sonner";
import { Aside } from "@/features/aside";
import { AuthModalTrigger } from "@/features/auth";
import { MobilePostButton } from "@/features/create-post";
import { MobileNavbar } from "@/features/navbar";
import { Sidebar } from "@/features/sidebar";
import { AuthProvider } from "@/utils/auth-provider";
import { ReactQueryProvider } from "@/utils/react-query-provider";
import { Command } from "./command";

import { Hamburger } from "./hamburger";
import { JoinMention } from "./join-mention";
import "./styles/layout.scss";
import LanguageSwitcher from "./LanguageSwitcher";

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  viewportFit: "cover",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "white" },
    { media: "(prefers-color-scheme: dark)", color: "black" },
  ],
};

export default async function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const nextCookies = cookies();
  const theme = nextCookies.get("theme")?.value;
  const color = nextCookies.get("color")?.value;
  const fontSize = nextCookies.get("font-size")?.value;

  return (
    <html
      {...(theme && { "data-theme": theme })}
      {...(color && { "data-color": color })}
      {...(fontSize && { "data-fontsize": fontSize })}
      lang="en"
    >
      <body suppressHydrationWarning={true}>
        <LocaleProvider>
          <a href="#home-timeline" className="sr-only">
            Skip to home timeline
          </a>

          <a href="#trending" className="sr-only">
            Skip to trending
          </a>

          <AuthProvider>
            <ReactQueryProvider>
              <div className="layout">
                <MobileNavbar />
                <div className="fixed bottom-20 right-4 z-fixed sm:hidden">
                  <MobilePostButton />
                </div>

                <Sidebar />

                <main aria-label="Home timeline" id="home-timeline">
                  {children}
                </main>

                <Aside />

                <Toaster />

                <Command />

                <AuthModalTrigger />
                <JoinMention />
                <Hamburger />
                <LanguageSwitcher />
              </div>
            </ReactQueryProvider>
          </AuthProvider>
          <Analytics />
          <SpeedInsights />
          <AxiomWebVitals />
        </LocaleProvider>
      </body>
    </html>
  );
}

export const metadata: Metadata = {
  title: {
    default: "Mention",
    template: "%s | Mention",
    absolute: "Mention",
  },
  description:
    "We believe in the potential of people when they can come together.",
  openGraph: {
    images: ["https://mention.earth/MentionBanner.png"],
  },
  generator: "Next.js",
  manifest: "/manifest.json",
  keywords: ["socialnetwork", "socialmedia", "social", "people"],
  authors: [
    { name: "Albert Isern Alvarez" },
    {
      name: "Oxy",
      url: "https://oxy.so/",
    },
  ],
  creator: "Albert Isern Alvarez",
  icons: [
    { rel: "apple-touch-icon", url: "icons/icon-128x128.png" },
    { rel: "icon", url: "icons/icon-128x128.png" },
  ],
};
