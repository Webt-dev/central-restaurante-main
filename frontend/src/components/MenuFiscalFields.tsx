import React, { useState } from 'react';
import { ChevronDown, ChevronRight, FileText } from 'lucide-react';

export interface MenuFiscalValues {
  ncm?: string | null;
  cfop?: string | null;
  cest?: string | null;
  csosn?: string | null;
  cst_icms?: string | null;
  cst_pis_cofins?: string | null;
  origem?: string | null;
  gtin?: string | null;
}

interface MenuFiscalFieldsProps {
  value: MenuFiscalValues;
  onChange: (next: MenuFiscalValues) => void;
  /** Abre já expandido (ex.: módulo fiscal ligado e produto sem NCM). */
  defaultOpen?: boolean;
}

const FIELDS: { key: keyof MenuFiscalValues; label: string; size: number; hint: string }[] = [
  { key: 'ncm', label: 'NCM', size: 8, hint: 'Obrigatório para emitir nota. 8 números.' },
  { key: 'cfop', label: 'CFOP', size: 4, hint: 'Vazio = padrão da configuração fiscal.' },
  { key: 'csosn', label: 'CSOSN (Simples)', size: 3, hint: 'Vazio = padrão.' },
  { key: 'cst_icms', label: 'CST ICMS (regime normal)', size: 2, hint: 'Vazio = padrão.' },
  { key: 'cst_pis_cofins', label: 'CST PIS/COFINS', size: 2, hint: 'Ex.: 04 para bebidas monofásicas.' },
  { key: 'cest', label: 'CEST', size: 7, hint: 'Só para itens com substituição tributária.' },
  { key: 'origem', label: 'Origem', size: 1, hint: '0 = nacional.' },
  { key: 'gtin', label: 'Código de barras (GTIN)', size: 14, hint: 'Opcional.' }
];

/** Dados fiscais do produto para a NFC-e. Confirme os códigos com o contador. */
export const MenuFiscalFields: React.FC<MenuFiscalFieldsProps> = ({ value, onChange, defaultOpen = false }) => {
  const [open, setOpen] = useState(defaultOpen || !value.ncm);

  return (
    <div className="card" style={{ boxShadow: 'none', background: 'var(--bg-subtle)' }}>
      <button
        type="button"
        className="btn btn-ghost btn-block"
        style={{ justifyContent: 'flex-start' }}
        onClick={() => setOpen(o => !o)}
        aria-expanded={open}
      >
        {open ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
        <FileText size={16} /> Dados fiscais (NFC-e)
        {!value.ncm && <span className="badge badge-pending" style={{ marginLeft: 'auto' }}>Sem NCM</span>}
      </button>
      {open && (
        <div className="form-grid card-pad" style={{ paddingTop: 0 }}>
          {FIELDS.map(f => (
            <div className="field" key={f.key}>
              <label className="label" htmlFor={`fiscal-${f.key}`}>{f.label}</label>
              <input
                id={`fiscal-${f.key}`}
                className="input"
                inputMode="numeric"
                maxLength={f.size}
                value={value[f.key] ?? ''}
                onChange={e => onChange({ ...value, [f.key]: e.target.value.replace(/\D/g, '') })}
              />
              <span className="hint">{f.hint}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};
