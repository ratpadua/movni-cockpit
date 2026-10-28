import ResourceManager, { FieldDef } from '../components/ResourceManager';

const fields: FieldDef[] = [
  { key: 'name', label: 'Nome', required: true },
  {
    key: 'flow',
    label: 'Tipo',
    type: 'select',
    options: [
      { value: 'in', label: 'Entrada' },
      { value: 'out', label: 'Saída' },
    ],
    format: (r) => (r.flow === 'in' ? 'Entrada' : r.flow === 'out' ? 'Saída' : 'Ambos'),
  },
];

export default function Categories() {
  return <ResourceManager title="Categorias" path="/categories" fields={fields} />;
}
