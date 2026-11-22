# One-off: sums GHS-POP R2023A (100 m, ESRI:54009 tile R9_C11 clipped to Tolima) inside each municipio and vereda.
# Inputs: zones.json (polygons exported from index.html) and the clipped GeoTIFFs; output: ghs_totals.json.
import sys, json, math, numpy as np, tifffile
from PIL import Image, ImageDraw
d=sys.argv[1]; z=json.load(open(d+'/zones.json'))
R=6378137.0   # ESRI:54009 World Mollweide sphere
X0,Y0,PX=-7650000,700000,100
def moll(lon,lat):
    phi=math.radians(lat); t=phi
    for _ in range(30):
        dt=(2*t+math.sin(2*t)-math.pi*math.sin(phi))/(2+2*math.cos(2*t)); t-=dt
        if abs(dt)<1e-12: break
    return R*2*math.sqrt(2)/math.pi*math.radians(lon)*math.cos(t), R*math.sqrt(2)*math.sin(t)
def pix(lon,lat):
    x,y=moll(lon,lat); return ((x-X0)/PX,(Y0-y)/PX)
pops={e:tifffile.imread(f'{d}/ghspop_{e}_tolima_100m_54009.tif').astype('float64') for e in (2025,2020)}
for a in pops.values(): a[a<0]=0
H,W=pops[2025].shape
def raster(zones):
    im=Image.new('I',(W,H),0); dr=ImageDraw.Draw(im)
    for k,polys in enumerate(zones,1):
        for rings in polys: dr.polygon([pix(*p) for p in rings[0]],fill=k)
        for rings in polys:
            for h in rings[1:]: dr.polygon([pix(*p) for p in h],fill=0)
    return np.array(im)
mz=[]
for n,g in z['mun']:
    cs=g['coordinates'] if g['type']=='MultiPolygon' else [g['coordinates']]
    mz.append([[[(lo,la) for lo,la in r] for r in poly] for poly in cs])
vz=[[[[(lo,la) for la,lo in r] for r in rings] for rings in polys] for _,_,polys in z['ver']]
lm=raster(mz); lv=raster(vz)
res={e:{'mun':np.bincount(lm.ravel(),weights=a.ravel(),minlength=len(mz)+1),'ver':np.bincount(lv.ravel(),weights=a.ravel(),minlength=len(vz)+1)} for e,a in pops.items()}
names=[n for n,_ in z['mun']]
out={'mun':{n:[round(res[2025]['mun'][i+1]),round(res[2020]['mun'][i+1])] for i,n in enumerate(names)},
     'ver':[[m,n,round(res[2025]['ver'][i+1]),round(res[2020]['ver'][i+1])] for i,(m,n,_) in enumerate(z['ver'])]}
json.dump(out,open(d+'/ghs_totals.json','w'),ensure_ascii=False)
wp=json.load(open('/mnt/project-files/tolima-dashboard/data/poblacion-municipios-worldpop2020.json'))
print('Tolima GHS2025',sum(v[0] for v in out['mun'].values()),'GHS2020',sum(v[1] for v in out['mun'].values()),'WP2020',sum(wp.values()),'vereda sum 2025',sum(v[2] for v in out['ver']),'zero veredas',sum(1 for v in out['ver'] if v[2]==0))
for n in sorted(names,key=lambda n:-out['mun'][n][0]): print(f"{n:22s} GHS25 {out['mun'][n][0]:>8} GHS20 {out['mun'][n][1]:>8} WP20 {wp.get(n,0):>8}")
