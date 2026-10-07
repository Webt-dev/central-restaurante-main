import React, { useEffect, useState } from 'react';
import { FileText, Save, Plug, AlertTriangle, CheckCircle2, Info } from 'lucide-react';
import { api, type FiscalConfig, type FiscalConfigResponse } from '../services/api';

interface FiscalModulePanelProps {
  onMessage: (type: 'success' | 'error', text: string) => void;
}

const UFS = ['AC', 'AL', 'AP', 'AM', 'BA', 'CE', 'DF', 'ES', 'GO', 'MA', 'MT', 'MS', 'MG', 'PA', 'PB', 'PR', 'PE', 'PI', 'RJ', 'RN', 'RS', 'RO', 'RR', 'SC', 'SP', 'SE', 'TO'];

/**
 * Gestão → Módulos → Emissão fiscal (NFC-e).
 *
 * O módulo vem desligado. Para ligar: preencher a configuração, cadastrar o
 * NCM dos produtos e passar no teste de comunicação com a SEFAZ. O ADMIN
 * desliga a qualquer momento (desde que não haja nota pendente).
 */
export const FiscalModulePanel: React.FC<FiscalModulePanelProps> = ({ onMessage }) => {
  const [data, setData] = useState<FiscalConfigResponse | null>(null);
  const [form, setForm] = useState<FiscalConfig | null>(null);
  const [busy, setBusy] = useState<'save' | 'test' | 'toggle' | null>(null);
  const [testResult, setTestResult] = useState<{ online: boolean; motivo: string } | null>(null);

  useEffect(() => {
    load();
  }, []);

  async function load() {
    try {
      const r = await api.getFiscalConfig();
      setData(r);
      setForm(r.config);
    } catch (err: any) {
      onMessage('error', err.message || 'Não foi possível carregar a configuração fiscal.');
    }
  }

  function set<K extends keyof FiscalConfig>(key: K, value: FiscalConfig[K]) {
    setForm(f => (f ? { ...f, [key]: value } : f));
  }

  async function handleSave(e?: React.FormEvent) {
    e?.preventDefault();
    if (!form) return;
    setBusy('save');
    try {
      const { enabled, ...rest } = form;
      const r = await api.updateFiscalConfig(rest);
      setData(r);
      setForm(r.config);
      onMessage('success', 'Configuração fiscal salva.');
    } catch (err: any) {
      onMessage('error', err.message || 'Não foi possível salvar.');
    } finally {
      setBusy(null);
    }
  }

  async function handleTest() {
    setBusy('test');
    setTestResult(null);
    try {
      await handleSave();
      setTestResult(await api.testarFiscal());
    } catch (err: any) {
      setTestResult({ online: false, motivo: err.message });
    } finally {
      setBusy(null);
    }
  }

  async function handleToggle() {
    if (!form) return;
    const next = !form.enabled;
    if (!next && !window.confirm('Desligar a emissão de NFC-e? O caixa deixará de emitir notas.')) return;
    setBusy('toggle');
    try {
      await api.ativarFiscal(next);
      onMessage('success', next ? 'Emissão de NFC-e ligada.' : 'Emissão de NFC-e desligada.');
      await load();
    } catch (err: any) {
      onMessage('error', err.message || 'Não foi possível alterar o módulo.');
    } finally {
      setBusy(null);
    }
  }

  if (!form || !data) return <div className="empty-state">Carregando...</div>;

  const pronto = data.pendencias.length === 0;
  const simples = form.crt !== '3';

  return (
    <div style={{ width: '100%', maxWidth: '820px', margin: '0 auto', display: 'flex', flexDirection: 'column', gap: '16px' }}>
      <section className="card card-pad" style={{ display: 'flex', gap: '16px', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap' }}>
        <div style={{ flex: '1 1 320px' }}>
          <h2 className="section-title"><FileText size={18} /> Emissão fiscal (NFC-e)</h2>
          <p className="hint" style={{ marginTop: '4px' }}>
            {form.enabled
              ? `Ligada — ${form.ambiente === 1 ? 'PRODUÇÃO (notas com valor fiscal)' : 'homologação (notas de teste, sem valor fiscal)'}${form.provider === 'simulacao' ? ', simulação' : ', via ACBrMonitor'}.`
              : 'Desligada. Use quando o próprio sistema emitir as notas do restaurante. Quem já tem outro emissor ou é MEI pode deixar desligado.'}
          </p>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={form.enabled}
          aria-label="Emissão de NFC-e"
          className={`switch ${form.enabled ? 'is-on' : ''}`}
          disabled={busy !== null || (!form.enabled && !pronto)}
          onClick={handleToggle}
          title={!form.enabled && !pronto ? 'Resolva as pendências abaixo para ligar' : undefined}
        >
          <span className="switch-knob" />
          <span className="switch-label">{form.enabled ? 'Ligada' : 'Desligada'}</span>
        </button>
      </section>

      {data.pendencias.length > 0 && (
        <div className="alert alert-warning" style={{ alignItems: 'flex-start' }}>
          <AlertTriangle size={17} />
          <div>
            <strong>Para ligar, falta:</strong>
            <ul style={{ paddingLeft: '18px', marginTop: '4px' }}>
              {data.pendencias.map(p => <li key={p}>{p}</li>)}
            </ul>
          </div>
        </div>
      )}

      {data.produtos_sem_ncm.length > 0 && (
        <div className="card card-pad">
          <h3 className="section-title">Produtos sem NCM ({data.produtos_sem_ncm.length})</h3>
          <p className="hint" style={{ margin: '4px 0 8px' }}>Cadastre em Gestão → Cardápio → Editar → Dados fiscais. O contador informa o NCM de cada item.</p>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
            {data.produtos_sem_ncm.slice(0, 40).map(p => <span key={p.id} className="badge badge-neutral">{p.name}</span>)}
            {data.produtos_sem_ncm.length > 40 && <span className="hint">e mais {data.produtos_sem_ncm.length - 40}…</span>}
          </div>
        </div>
      )}

      <form onSubmit={handleSave} className="card card-pad" style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
        <div className="section">
          <h3 className="section-title"><Plug size={17} /> 1. Motor fiscal</h3>
          <div className="alert alert-info" style={{ margin: '8px 0 12px' }}>
            <Info size={16} />
            <span>
              No computador do caixa, instale o <strong>ACBrMonitorPLUS</strong> e configure nele o certificado digital A1 do restaurante,
              o CSC/ID Token da SEFAZ e a UF. Este sistema envia as vendas para o ACBr, que assina, transmite e imprime a nota.
            </span>
          </div>
          <div className="form-grid">
            <div className="field">
              <label className="label" htmlFor="f-provider">Motor</label>
              <select id="f-provider" className="input" value={form.provider} onChange={e => set('provider', e.target.value as FiscalConfig['provider'])}>
                <option value="acbr">ACBrMonitorPLUS (emissão real)</option>
                <option value="simulacao">Simulação (só homologação, sem valor fiscal)</option>
              </select>
            </div>
            <div className="field">
              <label className="label" htmlFor="f-amb">Ambiente</label>
              <select id="f-amb" className="input" value={form.ambiente} onChange={e => set('ambiente', Number(e.target.value) as 1 | 2)}>
                <option value={2}>Homologação (testes)</option>
                <option value={1}>Produção (valor fiscal)</option>
              </select>
            </div>
            {form.provider === 'acbr' && (
              <>
                <div className="field">
                  <label className="label" htmlFor="f-host">Endereço do ACBrMonitor</label>
                  <input id="f-host" className="input" value={form.acbr_host} onChange={e => set('acbr_host', e.target.value)} />
                </div>
                <div className="field">
                  <label className="label" htmlFor="f-port">Porta TCP</label>
                  <input id="f-port" className="input" inputMode="numeric" value={form.acbr_port} onChange={e => set('acbr_port', Number(e.target.value.replace(/\D/g, '')))} />
                </div>
              </>
            )}
            <div className="field">
              <label className="label" htmlFor="f-serie">Série da NFC-e</label>
              <input id="f-serie" className="input" inputMode="numeric" value={form.serie} onChange={e => set('serie', Number(e.target.value.replace(/\D/g, '')))} />
            </div>
          </div>
        </div>

        <div className="section">
          <h3 className="section-title">2. Emitente (dados do restaurante na SEFAZ)</h3>
          <div className="form-grid" style={{ marginTop: '8px' }}>
            <div className="field"><label className="label" htmlFor="f-cnpj">CNPJ</label><input id="f-cnpj" className="input" inputMode="numeric" value={form.cnpj} onChange={e => set('cnpj', e.target.value)} /></div>
            <div className="field"><label className="label" htmlFor="f-ie">Inscrição estadual</label><input id="f-ie" className="input" inputMode="numeric" value={form.ie} onChange={e => set('ie', e.target.value)} /></div>
            <div className="field"><label className="label" htmlFor="f-razao">Razão social</label><input id="f-razao" className="input" value={form.razao_social} onChange={e => set('razao_social', e.target.value)} /></div>
            <div className="field"><label className="label" htmlFor="f-fantasia">Nome fantasia</label><input id="f-fantasia" className="input" value={form.nome_fantasia} onChange={e => set('nome_fantasia', e.target.value)} /></div>
            <div className="field">
              <label className="label" htmlFor="f-crt">Regime tributário</label>
              <select id="f-crt" className="input" value={form.crt} onChange={e => set('crt', e.target.value as FiscalConfig['crt'])}>
                <option value="">Escolha...</option>
                <option value="1">Simples Nacional</option>
                <option value="2">Simples Nacional — excesso de sublimite</option>
                <option value="3">Regime normal (Lucro Presumido/Real)</option>
                <option value="4">MEI</option>
              </select>
            </div>
            <div className="field"><label className="label" htmlFor="f-tel">Telefone</label><input id="f-tel" className="input" inputMode="tel" value={form.telefone} onChange={e => set('telefone', e.target.value)} /></div>
            <div className="field"><label className="label" htmlFor="f-lgr">Logradouro</label><input id="f-lgr" className="input" value={form.logradouro} onChange={e => set('logradouro', e.target.value)} /></div>
            <div className="field"><label className="label" htmlFor="f-nro">Número</label><input id="f-nro" className="input" value={form.numero} onChange={e => set('numero', e.target.value)} /></div>
            <div className="field"><label className="label" htmlFor="f-bairro">Bairro</label><input id="f-bairro" className="input" value={form.bairro} onChange={e => set('bairro', e.target.value)} /></div>
            <div className="field"><label className="label" htmlFor="f-mun">Município</label><input id="f-mun" className="input" value={form.municipio} onChange={e => set('municipio', e.target.value)} /></div>
            <div className="field"><label className="label" htmlFor="f-cmun">Código IBGE do município</label><input id="f-cmun" className="input" inputMode="numeric" maxLength={7} value={form.codigo_municipio} onChange={e => set('codigo_municipio', e.target.value)} /></div>
            <div className="field">
              <label className="label" htmlFor="f-uf">UF</label>
              <select id="f-uf" className="input" value={form.uf} onChange={e => set('uf', e.target.value)}>
                <option value="">Escolha...</option>
                {UFS.map(uf => <option key={uf} value={uf}>{uf}</option>)}
              </select>
            </div>
            <div className="field"><label className="label" htmlFor="f-cep">CEP</label><input id="f-cep" className="input" inputMode="numeric" value={form.cep} onChange={e => set('cep', e.target.value)} /></div>
          </div>
        </div>

        <div className="section">
          <h3 className="section-title">3. Tributação padrão</h3>
          <p className="hint" style={{ margin: '4px 0 8px' }}>Usada nos produtos que não têm um código próprio. Confirme cada código com o contador do restaurante.</p>
          <div className="form-grid">
            <div className="field"><label className="label" htmlFor="f-cfop">CFOP padrão</label><input id="f-cfop" className="input" inputMode="numeric" maxLength={4} placeholder="ex.: 5102" value={form.cfop_padrao} onChange={e => set('cfop_padrao', e.target.value.replace(/\D/g, ''))} /></div>
            {simples ? (
              <div className="field"><label className="label" htmlFor="f-csosn">CSOSN padrão</label><input id="f-csosn" className="input" inputMode="numeric" maxLength={3} placeholder="ex.: 102" value={form.csosn_padrao} onChange={e => set('csosn_padrao', e.target.value.replace(/\D/g, ''))} /></div>
            ) : (
              <div className="field"><label className="label" htmlFor="f-cst">CST de ICMS padrão</label><input id="f-cst" className="input" inputMode="numeric" maxLength={2} placeholder="ex.: 00" value={form.cst_icms_padrao} onChange={e => set('cst_icms_padrao', e.target.value.replace(/\D/g, ''))} /></div>
            )}
            <div className="field"><label className="label" htmlFor="f-pis">CST de PIS/COFINS padrão</label><input id="f-pis" className="input" inputMode="numeric" maxLength={2} placeholder="ex.: 49" value={form.cst_pis_cofins_padrao} onChange={e => set('cst_pis_cofins_padrao', e.target.value.replace(/\D/g, ''))} /></div>
            <div className="field"><label className="label" htmlFor="f-orig">Origem padrão</label><input id="f-orig" className="input" inputMode="numeric" maxLength={1} value={form.origem_padrao} onChange={e => set('origem_padrao', e.target.value.replace(/\D/g, ''))} /></div>
          </div>
        </div>

        {testResult && (
          <div className={`alert ${testResult.online ? 'alert-success' : 'alert-error'}`} role="status">
            {testResult.online ? <CheckCircle2 size={17} /> : <AlertTriangle size={17} />}
            {testResult.online ? 'SEFAZ respondeu: ' : 'Falhou: '}{testResult.motivo}
          </div>
        )}

        <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap' }}>
          <button type="submit" className="btn btn-primary" disabled={busy !== null}><Save size={16} /> {busy === 'save' ? 'Salvando...' : 'Salvar configuração'}</button>
          <button type="button" className="btn btn-outline" disabled={busy !== null} onClick={handleTest}><Plug size={16} /> {busy === 'test' ? 'Testando...' : 'Testar conexão com a SEFAZ'}</button>
        </div>
      </form>
    </div>
  );
};
