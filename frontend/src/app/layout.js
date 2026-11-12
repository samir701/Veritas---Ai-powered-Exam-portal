import "./globals.css";

export const metadata = {
  title: "Veritas Exam Portal — Online Assessment Platform",
  description: "Browser-based MCQ assessment platform for companies, interviewers, and candidates.",
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}

