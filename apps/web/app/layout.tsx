import type { Metadata } from 'next';
import './style.css';
export const metadata: Metadata = {title:'CloudDeck — Server operations',description:'Servers, metrics and operations in one workspace'};
export default function RootLayout({children}:{children:React.ReactNode}) {return <html lang="en"><body>{children}</body></html>}
