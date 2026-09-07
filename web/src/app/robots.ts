import type { MetadataRoute } from "next";

// Crawlers may index the landing page, Explore and every public
// organization and repository; the signed-in areas, the auth screens and the
// API are not pages to index. Private content is protected by sign-in, not
// by this file.
export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: "*",
        allow: "/",
        disallow: [
          "/admin",
          "/settings",
          "/dashboard",
          "/orgs",
          "/search",
          "/api/",
          "/sign-in",
          "/sign-up",
          "/accept-invitation",
          "/email-otp",
          "/forgot-password",
          "/reset-password",
          "/two-factor",
        ],
      },
    ],
  };
}
