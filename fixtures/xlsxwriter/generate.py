import xlsxwriter,csv,zipfile,os,re,json
from datetime import datetime
from pathlib import Path
P=Path('/workspace/scratch/615fdf9d2ed2/xlsx-test')
def book(name,fn):
 t='/tmp/'+name; w=xlsxwriter.Workbook(t); fn(w); w.close();os.replace(t,P/name)
def formatted(w):
 s=w.add_worksheet('Formatted'); h=['id','text_id','padded_id','amount','date','percent','currency','zero','false','empty','note'];s.write_row(0,0,h)
 for r in range(1,3):
  s.write(r,0,str(r));s.write_string(r,1,'0007');s.write_number(r,2,7,w.add_format({'num_format':'0000'}));s.write_number(r,3,1234.5,w.add_format({'num_format':'#,##0.00'}));s.write_datetime(r,4,datetime(2026,1,5),w.add_format({'num_format':'yyyy-mm-dd'}));s.write_number(r,5,.12,w.add_format({'num_format':'0%'}));s.write_number(r,6,1234.5,w.add_format({'num_format':'$#,##0.00'}));s.write_formula(r,7,'=1-1',None,0);s.write_formula(r,8,'=1=2',None,False);s.write_formula(r,9,'=""',None,'');s.write(r,10,'comma, newline\nUnicode ₹')
book('formatted.xlsx',formatted)
with open(P/'formatted.csv','w',newline='') as f:
 z=csv.writer(f);z.writerow(['id','text_id','padded_id','amount','date','percent','currency','zero','false','empty','note']);z.writerows([[str(r),'0007','0007','1,234.50','2026-01-05','12%','$1,234.50','0','FALSE','','comma, newline\nUnicode ₹'] for r in range(1,3)])
def simple(w,rows):
 s=w.add_worksheet('Data');s.write_row(0,0,['id','value']);
 for r,row in enumerate(rows,1):s.write_row(r,0,row)
book('old.xlsx',lambda w:simple(w,[['1','same'],['2','before'],['3','remove']]))
book('new.xlsx',lambda w:simple(w,[['1','same'],['2','after'],['4','add']]))
def multi(w):
 s=w.add_worksheet('Broken');s.write_row(0,0,['id','value']);s.write(1,0,'1');s.write_formula(1,1,'=1+1',None,2)
 s=w.add_worksheet('Valid');s.write_row(2,0,['id','value','note']);s.write_row(3,0,['1','alpha']);s.set_row(4,None,None,{'hidden':True});s.write_row(4,0,['2','beta','hidden']);s.merge_range('C6:D6','');s.write_row(5,0,['3','gamma','']);
book('multi.xlsx',multi)
def patch(name,src,fn):
 with zipfile.ZipFile(P/src) as z,zipfile.ZipFile('/tmp/'+name,'w',zipfile.ZIP_DEFLATED) as out:
  for n in z.namelist():out.writestr(n,fn(n,z.read(n)))
 os.replace('/tmp/'+name,P/name)
patch('multi.xlsx','multi.xlsx',lambda n,b: re.sub(b'(<f>1\+1</f>)<v>2</v>',rb'\1',b) if n=='xl/worksheets/sheet1.xml' else b)
with open(P/'multi.csv','w',newline='') as f:csv.writer(f).writerows([['id','value','note'],['1','alpha',''],['2','beta','hidden'],['3','gamma','']])
book('extra.xlsx',lambda w:simple(w,[['1','ok','extra']]))
book('missing-header.xlsx',lambda w:(lambda s:(s.write_formula(0,0,'="id"',None,'id'),s.write(0,1,'value'),s.write_row(1,0,['1','ok'])))(w.add_worksheet('Data')))
patch('missing-header.xlsx','missing-header.xlsx',lambda n,b:re.sub(b'<v>id</v>',b'',b) if n=='xl/worksheets/sheet1.xml' else b)
book('missing-only-row.xlsx',lambda w:(lambda s:(s.write_row(0,0,['id','value']),s.write_formula(1,0,'=1',None,1)))(w.add_worksheet('Data')))
patch('missing-only-row.xlsx','missing-only-row.xlsx',lambda n,b:re.sub(b'(<f>1</f>)<v>1</v>',rb'\1',b) if n=='xl/worksheets/sheet1.xml' else b)
patch('over-fields.xlsx','old.xlsx',lambda n,b:b.replace(b'A1:B4',b'A1:B1000002') if n=='xl/worksheets/sheet1.xml' else b)
with open('/tmp/oversize.xlsx','wb') as f:f.truncate(25*1024*1024+1)
os.replace('/tmp/oversize.xlsx',P/'oversize.xlsx')
(P/'legacy.xls').write_bytes(bytes.fromhex('D0CF11E0A1B11AE1')+bytes(504))
def wide(w,new=False):
 w.add_worksheet('Decoy').write_row(0,0,['id','decoy'])
 s=w.add_worksheet('Wide');s.write_row(0,0,['id']+['c'+str(c) for c in range(1,50)])
 for r in range(1,10001):s.write_row(r,0,[str(r)]+[('changed' if new and r%2==0 and c==1 else 'v'+str(r)+'-'+str(c)) for c in range(1,50)])
book('wide-old.xlsx',lambda w:wide(w));book('wide-new.xlsx',lambda w:wide(w,True))
print(json.dumps({p.name:p.stat().st_size for p in P.iterdir()}))
