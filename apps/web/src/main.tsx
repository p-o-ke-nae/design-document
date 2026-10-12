import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from '#app-impl';
import { TokenRequired } from './components/TokenRequired.tsx';
import './styles.css';

// The server marks index.html when the session cookie is missing: show the guide without calling the API.
const tokenRequired = document.querySelector('meta[name="ddv-auth"]') !== null;

createRoot(document.getElementById('root')!).render(<StrictMode>{tokenRequired ? <TokenRequired /> : <App />}</StrictMode>);
