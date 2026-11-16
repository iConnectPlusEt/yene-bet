import './globals.css';

export const metadata = {
  title: 'My Home · someone to vent to',
  description: 'Vent anonymously to someone who is free right now and can relate.',
  robots: { index: false },
};

export const viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#f5efe6' },
    { media: '(prefers-color-scheme: dark)', color: '#1c1917' },
  ],
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
