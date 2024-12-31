'use client';

import Link from 'next/link';

export default function About() {
  return (
    <div className="w-screen h-screen bg-gray-900 text-white flex flex-col items-center justify-center p-4">
      <div className="max-w-2xl text-center">
        <h1 className="text-xl mb-12">純粋な石</h1>
        <p className="text-xs mb-24">
          周囲の景観や環境音に合わせて表面変化・発光する石。
        </p>
        <Link 
          href="/" 
          className="inline-block px-6 py-3 text-xl text-white rounded-full hover:bg-gray-400 transition-colors"
        >
          Back
        </Link>
      </div>
    </div>
  );
} 