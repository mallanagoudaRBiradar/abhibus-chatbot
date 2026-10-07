import { createRoot } from 'react-dom/client';
import App from './App';
import './proto.css';
import './app.css';
import './design.css'; // design system: loaded last, overrides the prototype look

createRoot(document.getElementById('root')!).render(<App />);
