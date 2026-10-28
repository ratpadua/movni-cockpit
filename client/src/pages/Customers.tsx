import { useNavigate } from 'react-router-dom';
import ResourceManager, { FieldDef } from '../components/ResourceManager';

const fields: FieldDef[] = [
  { key: 'name', label: 'Nome', required: true },
  { key: 'nickname', label: 'Apelido' },
  { key: 'document', label: 'Documento (CPF/CNPJ)' },
  { key: 'email', label: 'E-mail' },
  { key: 'phone', label: 'Telefone', placeholder: '+55 48 99999-9999' },
  { key: 'whatsapp', label: 'WhatsApp', placeholder: '+55 48 99999-9999' },
  {
    key: 'preferredContact',
    label: 'Contato preferido',
    type: 'select',
    options: [
      { value: 'whatsapp', label: 'WhatsApp' },
      { value: 'email', label: 'E-mail' },
    ],
    inTable: false,
  },
  // Address split into parts
  { key: 'address', label: 'Endereço', placeholder: 'Rua, número', inTable: false },
  { key: 'neighborhood', label: 'Bairro', inTable: false },
  { key: 'city', label: 'Cidade' },
  { key: 'state', label: 'Estado (UF)', placeholder: 'SC' },
];

export default function Customers() {
  const navigate = useNavigate();
  return (
    <ResourceManager
      title="Clientes"
      path="/customers"
      fields={fields}
      onRowClick={(row) => navigate(`/customers/${row.id}`)}
    />
  );
}
