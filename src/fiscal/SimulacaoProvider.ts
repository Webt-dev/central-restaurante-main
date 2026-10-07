import { randomInt } from 'node:crypto';
import { Ambiente, FiscalProvider, FiscalIndisponivelError, NfceInput, ResultadoEmissao, StatusServico } from './types.js';
import { montarChaveAcesso } from '../utils/fiscalUtils.js';

/**
 * Provedor de simulação — SEM VALOR FISCAL.
 *
 * Gera chave de acesso válida e "autoriza" na hora, sem falar com a SEFAZ.
 * Só funciona em homologação (ambiente 2); o FiscalService recusa usá-lo em
 * produção. Serve para demonstrar o fluxo ao cliente e para os testes.
 *
 * Para testar contingência: SIMULACAO_OFFLINE=1 faz o "serviço" ficar fora do ar.
 */
export class SimulacaoProvider implements FiscalProvider {
  readonly nome = 'simulacao';

  private get offline(): boolean {
    return process.env.SIMULACAO_OFFLINE === '1';
  }

  async statusServico(ambiente: Ambiente): Promise<StatusServico> {
    if (ambiente !== 2) return { online: false, motivo: 'Simulação só é permitida em homologação.' };
    if (this.offline) return { online: false, motivo: 'Simulação: SEFAZ fora do ar.' };
    return { online: true, motivo: '107 Serviço em operação (simulação)' };
  }

  private chave(input: NfceInput): string {
    return montarChaveAcesso({
      uf: input.emitente.uf,
      dataEmissao: new Date(input.emissao),
      cnpj: input.emitente.cnpj,
      modelo: '65',
      serie: input.serie,
      numero: input.numero,
      tipoEmissao: input.tp_emis,
      codigoNumerico: randomInt(1, 99_999_999)
    });
  }

  async emitir(input: NfceInput): Promise<ResultadoEmissao> {
    if (input.ambiente !== 2) return { status: 'REJEITADO', motivo: 'Simulação só é permitida em homologação.' };
    if (input.tp_emis === 9) return { status: 'CONTINGENCIA', chave: this.chave(input), motivo: 'Emitida em contingência (simulação).' };
    if (this.offline) {
      throw new FiscalIndisponivelError('Simulação: SEFAZ fora do ar.');
    }
    return {
      status: 'AUTORIZADO',
      chave: this.chave(input),
      protocolo: `9${Date.now()}`.slice(0, 15),
      motivo: '100 Autorizado o uso da NF-e (simulação, sem valor fiscal)'
    };
  }

  async transmitirContingencia(chave: string, input: NfceInput): Promise<ResultadoEmissao> {
    if (this.offline) {
      throw new FiscalIndisponivelError('Simulação: SEFAZ fora do ar.');
    }
    return { status: 'AUTORIZADO', chave, protocolo: `9${Date.now()}`.slice(0, 15), motivo: `100 Contingência transmitida (simulação) — nota ${input.numero}` };
  }

  async cancelar() {
    return { ok: true, protocolo: `9${Date.now()}`.slice(0, 15), motivo: '135 Evento registrado (simulação)' };
  }
}
