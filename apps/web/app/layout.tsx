import type { Metadata } from 'next';
import '@xterm/xterm/css/xterm.css';
import './style.css';
import {GlobalCommandPalette} from '@/components/global-command-palette';
export const metadata: Metadata = {title:'CloudDeck — Server operations',description:'Servers, metrics and operations in one workspace'};
export default function RootLayout({children}:{children:React.ReactNode}) {return <html lang="en"><body>{children}<GlobalCommandPalette/></body></html>}
