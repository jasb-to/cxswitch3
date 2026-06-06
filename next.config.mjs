/** @type {import('next').NextConfig} */
const nextConfig = {
  typescript: {
    ignoreBuildErrors: true,
  },
  images: {
    unoptimized: true,
  },
  headers: async () => {
    return [
      {
        source: "/:path*",
        headers: [
          {
            key: "Content-Security-Policy",
            // Allow inline scripts and styles for frontend execution
            // script-src: 'self' + 'unsafe-inline' + 'unsafe-eval' for dynamic code
            // style-src: 'self' + 'unsafe-inline' for inline styles
            // This unblocks all frontend rendering
            value: "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval' https:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' data: https://fonts.gstatic.com; img-src 'self' data: https:; connect-src 'self' https:;",
          },
        ],
      },
    ];
  },
}

export default nextConfig 
