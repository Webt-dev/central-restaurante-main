/**
 * Utilitário para envio de cupom/relatório diretamente para a impressora física ou diálogo de impressão.
 */
export function printReceiptContent(content: string, docTitle: string = 'Cupom'): void {
  const printWindow = window.open('', '_blank', 'width=450,height=650');
  if (printWindow) {
    printWindow.document.write(`
      <!DOCTYPE html>
      <html>
        <head>
          <meta charset="utf-8" />
          <title>${docTitle}</title>
          <style>
            @page {
              margin: 0;
              size: auto;
            }
            @media print {
              body {
                padding: 0;
                margin: 0;
              }
            }
            body {
              font-family: 'Courier New', Courier, monospace;
              font-size: 12px;
              line-height: 1.35;
              padding: 10px;
              margin: 0;
              color: #000000;
              background: #ffffff;
              white-space: pre-wrap;
              word-break: break-all;
            }
          </style>
        </head>
        <body>${content.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</body>
      </html>
    `);
    printWindow.document.close();
    printWindow.focus();
    setTimeout(() => {
      printWindow.print();
      printWindow.close();
    }, 250);
  } else {
    // Fallback caso popups estejam bloqueados
    window.print();
  }
}
