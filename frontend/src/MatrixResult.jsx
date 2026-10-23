import React from 'react';
export function MatrixResult({ result, measures, onDrill }) {
  const matrix = result?.matrix;
  if (!matrix) return null;
  const display = cell => measures.map(a => `${a.function} ${a.field}: ${cell?.['_' + a.function]?.[a.field] ?? '—'}`).join(' · ');
  return <section className="overflow-auto my-4"><h2 className="font-semibold">{matrix.rowField} by {matrix.columnField}</h2><table className="w-full text-sm"><thead><tr><th>{matrix.rowField}</th>{matrix.columnValues.map((v,i)=><th className="p-2" key={i}>{String(v??'Not set')}</th>)}<th>Total</th></tr></thead><tbody>{matrix.rowValues.map((row,i)=><tr key={i}><th className="p-2 text-left">{String(row??'Not set')}</th>{matrix.columnValues.map((col,j)=>{const cell=matrix.cells.find(c=>c[matrix.rowField]===row&&c[matrix.columnField]===col);return <td className="p-2" key={j}><button className="underline" onClick={()=>onDrill([{field:matrix.rowField,operator:row==null?'is_null':'equals',value:row},{field:matrix.columnField,operator:col==null?'is_null':'equals',value:col}])}>{display(cell)}</button></td>;})}<td>{display(matrix.rowTotals[i])}</td></tr>)}</tbody><tfoot><tr><th>Total</th>{matrix.columnTotals.map((c,i)=><td className="p-2" key={i}>{display(c)}</td>)}<td>{display(result.totals?.data)}</td></tr></tfoot></table></section>;
}
