'use client';

import Link from 'next/link';

export default function About() {
  return (
    <div className="w-screen h-screen bg-black text-white flex flex-col items-center justify-center p-4">
      <div className="max-w-2xl text-center">
        <p className="text-xs mb-24">
          詳細なし
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