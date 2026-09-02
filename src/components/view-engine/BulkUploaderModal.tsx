'use client';

import { useState, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { parse } from 'papaparse';
import * as xlsx from 'xlsx';
import { supabase } from '@/lib/supabase/client';
import { Card, Button, Spinner, ErrorBox } from '@/components/ui/primitives';
import { pushToast } from '@/components/ui/Toaster';
import type { ModuleDef } from '@/modules/types';

interface BulkUploaderModalProps {
  mod: ModuleDef;
  onClose: () => void;
}

export function BulkUploaderModal({ mod, onClose }: BulkUploaderModalProps) {
  const queryClient = useQueryClient();
  const fileInputRef = useRef<HTMLInputElement>(null);
  
  const [file, setFile] = useState<File | null>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [previewData, setPreviewData] = useState<any[]>([]);
  const [columns, setColumns] = useState<string[]>([]);
  
  // Mapping of CSV header -> Module Field Key
  const [mapping, setMapping] = useState<Record<string, string>>({});
  
  const [isParsing, setIsParsing] = useState(false);
  const [isImporting, setIsImporting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const selected = e.target.files?.[0];
    if (!selected) return;
    setFile(selected);
    setError(null);
    setIsParsing(true);
    setMapping({});
    setPreviewData([]);
    
    try {
      if (selected.name.endsWith('.csv')) {
        parse(selected, {
          header: true,
          skipEmptyLines: true,
          complete: (results) => {
            if (results.errors.length) {
              console.warn('CSV Parse Warnings:', results.errors);
            }
            processParsedData(results.data as Record<string, string>[], results.meta.fields || []);
          },
          error: (err) => {
            setError(err.message);
            setIsParsing(false);
          }
        });
      } else if (selected.name.endsWith('.xlsx') || selected.name.endsWith('.xls')) {
        const buffer = await selected.arrayBuffer();
        const workbook = xlsx.read(buffer, { type: 'buffer' });
        const sheetName = workbook.SheetNames[0];
        const sheet = workbook.Sheets[sheetName];
        const data = xlsx.utils.sheet_to_json(sheet, { raw: false }) as Record<string, string>[];
        if (data.length > 0) {
          const cols = Object.keys(data[0]);
          processParsedData(data, cols);
        } else {
          setError('Spreadsheet is empty.');
          setIsParsing(false);
        }
      } else {
        setError('Unsupported file type. Please upload a .csv or .xlsx file.');
        setIsParsing(false);
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
      setIsParsing(false);
    }
  };

  const processParsedData = (data: Record<string, string>[], cols: string[]) => {
    setColumns(cols);
    setPreviewData(data);
    
    // Auto-map based on common heuristics
    const initialMapping: Record<string, string> = {};
    const modFields = mod.fields;
    
    for (const col of cols) {
      const lowerCol = col.toLowerCase().replace(/[^a-z0-9]/g, '');
      const match = modFields.find(f => {
        const lowerKey = f.key.toLowerCase().replace(/[^a-z0-9]/g, '');
        const lowerLabel = f.label.toLowerCase().replace(/[^a-z0-9]/g, '');
        return lowerKey === lowerCol || lowerLabel === lowerCol || 
               (lowerCol === 'status' && lowerKey === 'stage') ||
               (lowerCol === 'stage' && lowerKey === 'status');
      });
      if (match) {
        initialMapping[col] = match.key;
      } else {
        initialMapping[col] = '';
      }
    }
    
    setMapping(initialMapping);
    setIsParsing(false);
  };

  const handleImport = async () => {
    if (!previewData.length) return;
    setIsImporting(true);
    setError(null);
    
    try {
      // Build the records to insert
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const recordsToInsert: any[] = [];
      
      for (const row of previewData) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const record: any = {};
        for (const col of columns) {
          const targetFieldKey = mapping[col];
          if (targetFieldKey) {
            let val = row[col];
            const fieldDef = mod.fields.find(f => f.key === targetFieldKey);
            
            if (val === undefined || val === null || val === '') {
              continue; // skip empty
            }
            
            // Basic data normalization
            if (fieldDef?.type === 'number') {
              val = Number(val);
            } else if (fieldDef?.type === 'boolean') {
              val = ['true', 'yes', '1', 'y'].includes(String(val).toLowerCase());
            } else if (fieldDef?.type === 'enum' && fieldDef.enum) {
              // Ensure it matches enum case, or default to first if missing and we are mapping to something like stage
              const matchedEnum = fieldDef.enum.find(e => e.toLowerCase() === String(val).toLowerCase());
              if (matchedEnum) {
                val = matchedEnum;
              } else if (targetFieldKey === 'stage') {
                val = 'New'; // Default for leads
              }
            }
            
            record[targetFieldKey] = val;
          }
        }
        
        // Ensure required fields for specific modules
        if (mod.key === 'leads' && !record.company && record.contact_name) {
           record.company = record.contact_name; // Fallback
        }
        
        if (Object.keys(record).length > 0) {
          recordsToInsert.push(record);
        }
      }
      
      if (recordsToInsert.length === 0) {
        throw new Error('No valid data mapped to insert.');
      }

      const { error: insertErr } = await supabase()
        .from(mod.key)
        .insert(recordsToInsert);

      if (insertErr) throw insertErr;

      pushToast(`Successfully imported ${recordsToInsert.length} ${mod.plural.toLowerCase()}!`);
      queryClient.invalidateQueries({ queryKey: [mod.key] });
      onClose();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsImporting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-xs p-4">
      <Card title={`Import ${mod.plural} (CSV / Excel)`} className="w-full max-w-4xl bg-surface border-border shadow-xl flex flex-col max-h-[90vh]">
        
        <div className="flex-1 overflow-y-auto p-4 space-y-4 text-sm">
          {!file && (
            <div 
              className="border-2 border-dashed border-border rounded-lg p-10 flex flex-col items-center justify-center text-muted hover:border-accent hover:text-accent transition-colors cursor-pointer"
              onClick={() => fileInputRef.current?.click()}
            >
              <span className="text-2xl mb-2">📁</span>
              <p className="font-medium">Click to select a .csv or .xlsx file</p>
              <p className="text-xs mt-1">Make sure it has a header row.</p>
              <input 
                type="file" 
                ref={fileInputRef} 
                accept=".csv, .xlsx, .xls" 
                className="hidden" 
                onChange={handleFileChange} 
              />
            </div>
          )}

          {isParsing && <Spinner label="Parsing file..." />}
          
          {error && <ErrorBox error={error} />}

          {file && !isParsing && previewData.length > 0 && (
            <div className="space-y-4">
              <div className="flex justify-between items-center bg-raised p-3 rounded-lg border border-border">
                <div className="font-medium text-foreground">
                  File: {file.name} ({previewData.length} rows)
                </div>
                <Button variant="ghost" size="sm" onClick={() => setFile(null)}>
                  Change File
                </Button>
              </div>

              <div className="space-y-2">
                <h3 className="font-semibold text-[13px]">Map Columns</h3>
                <p className="text-[11px] text-muted">Select which CRM field each column from your file corresponds to. Leave blank to ignore the column.</p>
                
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
                  {columns.map(col => (
                    <div key={col} className="flex flex-col gap-1 border border-border rounded p-2 bg-raised/30">
                      <span className="text-[11px] font-mono text-muted truncate">{col}</span>
                      <select 
                        value={mapping[col] || ''}
                        onChange={(e) => setMapping(prev => ({ ...prev, [col]: e.target.value }))}
                        className="w-full rounded border border-border bg-surface p-1.5 text-xs focus:border-accent focus:outline-none"
                      >
                        <option value="">-- Ignore --</option>
                        {mod.fields.map(f => (
                          <option key={f.key} value={f.key}>{f.label} {f.required ? '*' : ''}</option>
                        ))}
                      </select>
                    </div>
                  ))}
                </div>
              </div>

              <div className="space-y-2 pt-4">
                <h3 className="font-semibold text-[13px]">Preview (First 3 Rows)</h3>
                <div className="overflow-x-auto border border-border rounded-lg bg-surface">
                  <table className="w-full text-left text-[12px]">
                    <thead className="bg-raised/50 border-b border-border">
                      <tr>
                        {columns.map(col => (
                          <th key={col} className="px-3 py-2 font-medium text-muted truncate max-w-[150px]">
                            {col} {mapping[col] ? `→ ${mod.fields.find(f => f.key === mapping[col])?.label}` : '(Ignored)'}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border">
                      {previewData.slice(0, 3).map((row, i) => (
                        <tr key={i} className="hover:bg-raised/30">
                          {columns.map(col => (
                            <td key={col} className="px-3 py-2 text-foreground truncate max-w-[150px]">
                              {row[col] ?? ''}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>

            </div>
          )}
        </div>

        <div className="border-t border-border p-4 flex justify-end gap-2 bg-surface rounded-b-lg">
          <Button variant="ghost" onClick={onClose} disabled={isImporting}>
            Cancel
          </Button>
          {file && previewData.length > 0 && (
            <Button 
              variant="primary" 
              onClick={handleImport} 
              disabled={isImporting || !Object.values(mapping).some(v => !!v)}
            >
              {isImporting ? 'Importing...' : `Import ${previewData.length} Rows`}
            </Button>
          )}
        </div>

      </Card>
    </div>
  );
}
