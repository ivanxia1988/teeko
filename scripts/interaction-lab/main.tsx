import {createRoot} from 'react-dom/client';
import InteractionLab from '../../components/lab/interaction-lab';
import '../../components/lab/interaction-lab.css';

const root=document.getElementById('root');
if(root)createRoot(root).render(<InteractionLab/>);
