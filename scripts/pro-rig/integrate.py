"""Build separate native candidates, retaining source art and unrelated bindings."""
import copy, hashlib, itertools, json, math, re, runpy, struct, sys, uuid, zlib
import xml.etree.ElementTree as E
from pathlib import Path

PROJECT=Path(__file__).resolve().parents[2]
import archive as archive_io
H=vars(archive_io)
field,deep,name=H['field'],H['deep'],H['name']
def bounds(a):return min(a[::2]),min(a[1::2]),max(a[::2]),max(a[1::2])
def points(f):return list(map(float,deep(f,'positions').text.split()))
def put(e,values):e.text=' '.join(f'{v:.8f}' for v in values);e.set('count',str(len(values)))
def own(e):return field(field(e,'super'),'guid').get('xs.ref')
def append(e,children):e.extend(children);e.set('count',str(len(e)))

def mouth_anchor(oldpos):
    """Keep the character's authored mouth tilt when placing a level donor."""
    x0,y0,x1,y1=bounds(oldpos)
    width=x1-x0
    if width<=0:raise ValueError('嘴部有效宽度无效')
    vertices=list(zip(oldpos[::2],oldpos[1::2]));band=max(width*.16,1e-6)
    left=[y for x,y in vertices if x<=x0+band]
    right=[y for x,y in vertices if x>=x1-band]
    if not left or not right:raise ValueError('无法识别嘴部左右嘴角')
    ly=sum(left)/len(left);ry=sum(right)/len(right)
    dx=x1-x0;dy=ry-ly;length=math.hypot(dx,dy)
    if length<=0:raise ValueError('嘴部基线无效')
    return {'center':((x0+x1)/2,(ly+ry)/2),'length':length,
            'angle':math.atan2(dy,dx),'corners':((x0,ly),(x1,ry)),
            'bounds':(x0,y0,x1,y1)}

def png_alpha_samples(data):
    """Read non-interlaced RGBA PNG alpha without a runtime image dependency."""
    if data[:8] != b'\x89PNG\r\n\x1a\n':raise ValueError('嘴部图层不是 PNG')
    pos=8;parts=[];width=height=bitdepth=color=interlace=None
    while pos<len(data):
        size=struct.unpack('>I',data[pos:pos+4])[0];kind=data[pos+4:pos+8];chunk=data[pos+8:pos+8+size];pos+=12+size
        if kind==b'IHDR':width,height,bitdepth,color,_,_,interlace=struct.unpack('>IIBBBBB',chunk)
        elif kind==b'IDAT':parts.append(chunk)
        elif kind==b'IEND':break
    if bitdepth!=8 or color!=6 or interlace!=0:raise ValueError('嘴部贴图必须是非隔行 8-bit RGBA PNG')
    raw=zlib.decompress(b''.join(parts));stride=width*4;previous=bytearray(stride);offset=0;samples=[]
    def paeth(a,b,c):
        p=a+b-c;pa=abs(p-a);pb=abs(p-b);pc=abs(p-c)
        return a if pa<=pb and pa<=pc else b if pb<=pc else c
    for y in range(height):
        mode=raw[offset];offset+=1;row=bytearray(raw[offset:offset+stride]);offset+=stride
        for i in range(stride):
            left=row[i-4] if i>=4 else 0;up=previous[i];upleft=previous[i-4] if i>=4 else 0
            if mode==1:row[i]=(row[i]+left)&255
            elif mode==2:row[i]=(row[i]+up)&255
            elif mode==3:row[i]=(row[i]+((left+up)//2))&255
            elif mode==4:row[i]=(row[i]+paeth(left,up,upleft))&255
            elif mode!=0:raise ValueError('嘴部 PNG 滤镜格式不受支持')
        for x in range(width):
            alpha=row[x*4+3]
            if alpha>8:samples.append(((x+.5)/width,(y+.5)/height,alpha))
        previous=row
    if len(samples)<8:raise ValueError('嘴部贴图没有足够的有效像素')
    visible_count=len(samples)
    # A malformed opaque full-canvas layer can contain a million samples.  It
    # has no extra anchoring information after a few thousand evenly spaced
    # pixels, but mapping all of them would stall the local relay.
    if len(samples)>2000:
        step=math.ceil(len(samples)/2000);samples=samples[::step]
    return samples,visible_count

def mouth_anchor_from_texture(original,oldpos,entries,resolve,key):
    """Map actual non-transparent mouth pixels through the authored mesh.

    A See-Through mouth layer is often a full-canvas PSD layer.  Its mesh
    perimeter tracks the face warp, not the painted mouth.  Anchoring from the
    alpha region prevents that perimeter from moving a donor mouth elsewhere.
    """
    texture=resolve(deep(original,'texture'));image=resolve(deep(texture,'srcImageResource'))
    filename=deep(image,'imageFileBuf').get('path')
    entry=next((e for e in entries if e['path']==filename),None)
    if entry is None:raise ValueError('找不到嘴部贴图，未替换通用嘴型')
    # archive.archive already removes CMO3 member obfuscation before exposing
    # ``stored``.  Do not xor it a second time here.
    content=entry['stored']
    if entry['compression']!=archive_io.caff.COMPRESS_RAW:content=archive_io.caff._zip_unwrap(content)
    samples,visible_count=png_alpha_samples(content)
    # A genuinely opaque canvas has no painted-mouth boundary to recover.
    # Keep the legacy mesh anchor for that atypical authoring format rather
    # than pretending the full canvas is a mouth silhouette.
    texture_pixels=int(getattr(image,'attrib',{}).get('width',0) or 0) * int(getattr(image,'attrib',{}).get('height',0) or 0)
    if texture_pixels and visible_count > texture_pixels*.85:
        fallback=mouth_anchor(oldpos)
        fallback.update({'paintedPixels':visible_count,'texture':filename,'alphaFallback':'opaque-layer'})
        return fallback
    uvs=list(map(float,field(original,'uvs').text.split()));indices=list(map(int,field(original,'indices').text.split()))
    if len(oldpos)!=len(uvs):raise ValueError('嘴部网格坐标与 UV 不一致')
    triangles=[]
    for ia,ib,ic in zip(indices[::3],indices[1::3],indices[2::3]):
        ax,ay=uvs[ia*2:ia*2+2];bx,by=uvs[ib*2:ib*2+2];cx,cy=uvs[ic*2:ic*2+2]
        det=(by-cy)*(ax-cx)+(cx-bx)*(ay-cy)
        if abs(det)>1e-12:triangles.append((ia,ib,ic,ax,ay,bx,by,cx,cy,det))
    mapped=[]
    for u,v,weight in samples:
        for ia,ib,ic,ax,ay,bx,by,cx,cy,det in triangles:
            a=((by-cy)*(u-cx)+(cx-bx)*(v-cy))/det
            b=((cy-ay)*(u-cx)+(ax-cx)*(v-cy))/det;c=1-a-b
            if min(a,b,c)>=-1e-6:
                x=a*oldpos[ia*2]+b*oldpos[ib*2]+c*oldpos[ic*2]
                y=a*oldpos[ia*2+1]+b*oldpos[ib*2+1]+c*oldpos[ic*2+1]
                mapped.append((x,y,weight));break
    if len(mapped)<8:raise ValueError('嘴部有效像素无法映射到网格，未替换通用嘴型')
    total=sum(w for _,_,w in mapped);cx=sum(x*w for x,_,w in mapped)/total;cy=sum(y*w for _,y,w in mapped)/total
    xx=sum(w*(x-cx)**2 for x,_,w in mapped)/total;xy=sum(w*(x-cx)*(y-cy) for x,y,w in mapped)/total;yy=sum(w*(y-cy)**2 for _,y,w in mapped)/total
    angle=.5*math.atan2(2*xy,xx-yy)
    if math.cos(angle)<0:angle+=math.pi
    ux,uy=math.cos(angle),math.sin(angle)
    projections=sorted(((x-cx)*ux+(y-cy)*uy,w) for x,y,w in mapped)
    def quantile(q):
        target=total*q;seen=0
        for value,weight in projections:
            seen+=weight
            if seen>=target:return value
        return projections[-1][0]
    length=quantile(.98)-quantile(.02)
    if length<=1e-6:raise ValueError('嘴部有效宽度无效')
    return {'center':(cx,cy),'length':length,'angle':angle,
            'paintedPixels':len(mapped),'texture':filename}

def build(character,source,donor_dir,output):
    if character != 'pro': raise ValueError('Only generic Pro inputs are accepted')
    assert not output.exists(),output
    output.parent.mkdir(parents=True,exist_ok=True)
    header,key,entries,root=H['archive'](source)
    _,_,dent,dr=H['archive'](donor_dir/'donor.cmo3')
    main=root.find('main/CModelSource');dm=dr.find('main/CModelSource');shared=root.find('shared')
    ids={e.get('xs.id'):e for e in root.iter() if e.get('xs.id')}
    dids={e.get('xs.id'):e for e in dr.iter() if e.get('xs.id')}
    before={e.get('xs.id'):E.tostring(e) for e in shared}
    counter=max(int(i[1:]) for i in ids)+1
    def alloc(e):
        nonlocal counter
        ident=f'#{counter}';counter+=1;e.set('xs.id',ident);e.set('xs.idx',ident[1:]);shared.append(e);ids[ident]=e;return ident
    def resolve(e):return ids[e.get('xs.ref')] if e.get('xs.ref') else e
    def sources(m,tag):return field(m.find(tag),'_sources')
    warps={name(e):e for e in shared if e.tag=='CWarpDeformerSource'}
    mouths=[e for e in shared if e.tag=='CArtMeshSource' and name(e).strip().lower()=='mouth']
    if len(mouths)!=1: raise ValueError('Pro 嘴部需要唯一独立 mouth 图层；请修正 PSD 的缺失、重复或 mouth_nose 合层')
    original=mouths[0]
    if any(e.tag=='CArtMeshSource' and name(e).startswith('native.mouth.') for e in shared): raise ValueError('输入已经包含原生嘴部，请使用原始 CMO3，避免重复绑定')
    mouthwarp=warps.get(name(original)+' Warp');fp=warps.get('FaceParallax')
    if mouthwarp is None or fp is None:
        raise ValueError('缺少独立嘴部变形器或九向头部，请从规范 PSD 重新生成 Pro 工程')
    report={'character':character,'source':str(source),'sourceSHA256':hashlib.sha256(source.read_bytes()).hexdigest(),'nativeVisualAccepted':False}
    # Existing authoring engine emits the full AngleX × AngleY 3×3 grid.
    # Preserve its geometry; never transplant a different character's eyes.
    forms=field(fp,'keyforms')
    grid=resolve(deep(fp,'keyformGridSource'))
    bindings=field(grid,'keyformBindings')
    axes={}
    params={field(p,'guid').get('xs.ref'):resolve(field(p,'id')).get('idstr') for p in sources(main,'CParameterSourceSet')}
    for ref in bindings:
        binding=resolve(ref)
        axes[params[field(binding,'parameterGuid').get('xs.ref')]]=[float(k.text) for k in field(binding,'keys')]
    if len(forms)!=9 or axes != {'ParamAngleX':[-30.,0.,30.], 'ParamAngleY':[-30.,0.,30.]}:
        raise ValueError('Pro 需要完整 AngleX × AngleY 九向绑定，请从 PSD 重新生成工程')
    if all(points(f)==points(forms[4]) for f in forms):
        raise ValueError('九向关键形态全部相同，阻止空绑定交付')
    report['head']={'source':'input','forms':9,'axes':axes,'changed':False,'policy':'preserve authored head and eyes; no cross-character transfer'}

    # Texture and mesh graph merge; only the original character's parameter
    # GUIDs and mouth part are shared, all donor objects receive fresh identities.
    bp={resolve(field(p,'id')).get('idstr'):p for p in sources(main,'CParameterSourceSet')}
    dp={dids.get(field(p,'id').get('xs.ref'),field(p,'id')).get('idstr'):p for p in sources(dm,'CParameterSourceSet')}
    partguid=deep(original,'parentGuid').get('xs.ref')
    groupguid=field(bp['ParamMouthOpenY'],'parentGroupGuid').get('xs.ref')
    mapping={}
    for ident in dids:mapping[ident]=f'#{counter}';counter+=1
    for pid in dp:
        assert pid in bp,pid
        mapping[field(dp[pid],'guid').get('xs.ref')]=field(bp[pid],'guid').get('xs.ref')
        field(bp[pid],'decimalPlaces').text='2'
    for e in dr.iter():
        if e.get('xs.id') and e.tag=='CPartGuid':mapping[e.get('xs.id')]=partguid
        if e.get('xs.id') and e.tag=='CParameterGroupGuid':mapping[e.get('xs.id')]=groupguid
        if e.get('xs.id') and e.tag=='CoordType':mapping[e.get('xs.id')]=deep(field(original,'keyforms')[0],'coordType').get('xs.ref')
    files={e['path']:'native_mouth_'+e['path'] for e in dent if e['path']!='main.xml'}
    uuids={}
    def remap(e):
        c=copy.deepcopy(e)
        for node in c.iter():
            for a in ['xs.id','xs.ref']:
                if node.get(a) in mapping:node.set(a,mapping[node.get(a)])
            if node.get('xs.id'):node.set('xs.idx',node.get('xs.id')[1:])
            for a,v in list(node.attrib.items()):
                if v in files:node.set(a,files[v])
            if node.text in files:node.text=files[node.text]
            if node.tag.endswith('Guid') and node.tag!='StaticFilterDefGuid' and node.get('uuid'):
                u=node.get('uuid');node.set('uuid',uuids.setdefault(u,str(uuid.uuid4())))
            if node.tag in ['CDrawableId','CDeformerId'] and node.get('idstr'):node.set('idstr','NativeMouth_'+node.get('idstr'))
        return c
    for e in dr.find('shared'):
        if mapping[e.get('xs.id')] in ids:continue
        c=remap(e);shared.append(c)
        for node in c.iter():
            if node.get('xs.id'):ids[node.get('xs.id')]=node
    base_xml=next(e for e in entries if e['path']=='main.xml');donor_xml=next(e for e in dent if e['path']=='main.xml')
    for declaration in re.findall(rb'<\?(?:import|version) .*?\?>',donor_xml['preamble']):
        if declaration in base_xml['preamble']:continue
        if declaration.startswith(b'<?version '):
            prefix=declaration.split(b':')[0]+b':'
            if prefix in base_xml['preamble']:continue
        base_xml['preamble']+=declaration+b'\n'
    entries.extend({**e,'path':files[e['path']]} for e in dent if e['path']!='main.xml')
    for category in ['_rawImages','_modelImageGroups']:append(field(main.find('CTextureManager'),category),[remap(e) for e in field(dm.find('CTextureManager'),category)])
    atlases=field(main.find('CTextureManager'),'_textureAtlases');atlases[:]=[];atlases.set('count','0')
    field(main.find('CTextureManager'),'isTextureInputModelImageMode').text='true'
    # Editor-saved Ana holds current atlas-region references even after atlas
    # registrations are cleared. Restore each original model-image input first.
    for ext in list(root.iter('CTextureInputExtension')):
        if not ext.get('xs.id'):continue
        inputs=field(ext,'_textureInputs')
        mi=next(resolve(e) for e in inputs if e.tag=='CTextureInput_ModelImage')
        if not mi.get('xs.id'):mi=copy.deepcopy(mi);alloc(mi)
        inputs[:]=[E.Element('CTextureInput_ModelImage',{'xs.ref':mi.get('xs.id')})];inputs.set('count','1')
        current=next((e for e in ext if e.get('xs.n')=='currentTextureInputData'),None)
        if current is not None:ext.remove(current)
        E.SubElement(ext,'CTextureInput_ModelImage',{'xs.n':'currentTextureInputData','xs.ref':mi.get('xs.id')})
    for state in root.iter('TextureState'):state.set('v','MODEL_IMAGE')
    part=next(e for e in root.iter('CPartSource') if not e.get('xs.ref') and field(e,'guid').get('xs.ref')==partguid)
    # Preserve its normal transformation, but remove the old mouth-only stretch:
    # opening is now authored on the four meshes and must not be applied twice.
    mouthgrid=resolve(deep(mouthwarp,'keyformGridSource'))
    for ref in field(mouthgrid,'keyformBindings'):
        binding=resolve(ref)
        if params.get(field(binding,'parameterGuid').get('xs.ref')) != 'ParamMouthOpenY':
            raise ValueError('嘴部变形器含额外手工绑定，需单独适配，原工程已保留')
    mwforms=field(mouthwarp,'keyforms');mwrest=points(mwforms[0]);
    for f in mwforms:put(deep(f,'positions'),mwrest)
    oldpos=points(field(original,'keyforms')[0]);anchor=mouth_anchor_from_texture(original,oldpos,entries,resolve,key)
    x0,y0,x1,y1=bounds(oldpos);cx,cy=anchor['center'];angle=anchor['angle']
    fw,fh=(lambda b:(b[2]-b[0],b[3]-b[1]))(bounds(points(field(fp,'keyforms')[4])))
    wx0,wy0,wx1,wy1=bounds(mwrest)
    if min(x1-x0, wx1-wx0, wy1-wy0, fw, fh)<=0: raise ValueError('嘴部或头部边界无效')
    sx=anchor['length']/276
    sy=sx*(wx1-wx0)*fw/((wy1-wy0)*fh)
    report['mouthPlacement']={'center':[cx,cy],'scale':[sx,sy],
        'rotationDegrees':math.degrees(angle),'paintedPixels':anchor['paintedPixels'],
        'sourceTexture':anchor['texture'],
        'parent':'mouth Warp','originalRetainedAtClosed':True}
    oldorder=int(deep(field(original,'keyforms')[0],'drawOrder').text)
    # Reserve four slots without disturbing relative order anywhere else.
    for e in list(shared):
        if e.tag=='CArtMeshSource' and e.get('xs.id') in before:
            for f in field(e,'keyforms'):
                order=int(deep(f,'drawOrder').text)
                deep(f,'drawOrder').text=str(order+4 if order>oldorder else order)
    def setforms(mesh,records,convert=True):
        grid=resolve(deep(mesh,'keyformGridSource'));gridref=deep(mesh,'keyformGridSource')
        if not grid.get('xs.id'):
            parent=next(e for e in mesh.iter() if gridref in list(e));newgrid=copy.deepcopy(grid);gid=alloc(newgrid);parent.remove(gridref);E.SubElement(parent,'KeyformGridSource',{'xs.n':'keyformGridSource','xs.ref':gid});grid=newgrid
        gid=grid.get('xs.id');grid[:]=[]
        cells=E.SubElement(grid,'array_list',{'xs.n':'keyformsOnGrid','count':str(len(records))});bindings=E.SubElement(grid,'array_list',{'xs.n':'keyformBindings','count':'2'});bids=[]
        for pid,ks in [('ParamMouthForm',[-1,0,1]),('ParamMouthOpenY',[0,.08,.4,1])]:
            b=E.Element('KeyformBindingSource');bid=alloc(b);bids.append(bid)
            E.SubElement(bindings,'KeyformBindingSource',{'xs.ref':bid});E.SubElement(b,'KeyformGridSource',{'xs.n':'_gridSource','xs.ref':gid});E.SubElement(b,'CParameterGuid',{'xs.n':'parameterGuid','xs.ref':field(bp[pid],'guid').get('xs.ref')})
            a=E.SubElement(b,'array_list',{'xs.n':'keys','count':str(len(ks))})
            for k in ks:E.SubElement(a,'f').text=str(k)
            for tag,n in [('InterpolationType','interpolationType'),('ExtendedInterpolationType','extendedInterpolationType')]:E.SubElement(b,tag,{'xs.n':n,'v':'LINEAR'})
            E.SubElement(b,'i',{'xs.n':'insertPointCount'}).text='1';E.SubElement(b,'f',{'xs.n':'extendedInterpolationScale'}).text='1.0';E.SubElement(b,'s',{'xs.n':'description'}).text=pid
        forms=field(mesh,'keyforms');template=copy.deepcopy(forms[0]);forms[:]=[];forms.set('count',str(len(records)))
        for i,rec in enumerate(records):
            form=copy.deepcopy(template);g=alloc(E.Element('CFormGuid',{'uuid':str(uuid.uuid4()),'note':name(mesh)+' '+str(i)}));deep(form,'guid').set('xs.ref',g);deep(form,'_source').set('xs.ref',mesh.get('xs.id'))
            p=rec['positions']
            if convert:
                # The donor is level around (200,75); preserve the source
                # mouth baseline so a tilted face cannot receive a level mouth.
                cos,sin=math.cos(angle),math.sin(angle);placed=[]
                for px,py in zip(p[::2],p[1::2]):
                    u=(px-200)*sx;v=(py-75)*sy
                    placed.extend((cx+cos*u-sin*v,cy+sin*u+cos*v))
                p=placed
            put(deep(form,'positions'),p)
            deep(form,'opacity').text=str(rec['opacity']);forms.append(form)
            cell=E.SubElement(cells,'KeyformOnGrid');access=E.SubElement(cell,'KeyformGridAccessKey',{'xs.n':'accessKey'});a=E.SubElement(access,'array_list',{'xs.n':'_keyOnParameterList','count':'2'})
            for bid,index in zip(bids,[i%3,i//3]):
                kp=E.SubElement(a,'KeyOnParameter');E.SubElement(kp,'KeyformBindingSource',{'xs.n':'binding','xs.ref':bid});E.SubElement(kp,'i',{'xs.n':'keyIndex'}).text=str(index)
            E.SubElement(cell,'CFormGuid',{'xs.n':'keyformGuid','xs.ref':g})
    shapes=json.loads((donor_dir/'geometry.json').read_text());added=[]
    for i,shape in enumerate(shapes):
        donor=next(e for e in dr.iter('CArtMeshSource') if e.get('xs.id') and name(e)==shape['name']);mesh=ids[mapping[donor.get('xs.id')]]
        deep(mesh,'targetDeformerGuid').set('xs.ref',own(mouthwarp));setforms(mesh,shape['forms'])
        for f in field(mesh,'keyforms'):deep(f,'drawOrder').text=str(oldorder+i+1)
        append(sources(main,'CDrawableSourceSet'),[E.Element('CArtMeshSource',{'xs.ref':mesh.get('xs.id')})]);append(field(part,'_childGuids'),[E.Element('CDrawableGuid',{'xs.ref':own(mesh)})]);added.append(mesh)
    clip=deep(added[1],'clipGuidList');clip[:]=[];append(clip,[E.Element('CDrawableGuid',{'xs.ref':own(added[0])})])
    if character=='pro':setforms(original,[{'positions':oldpos,'opacity':1 if o==0 else 0} for o in [0,.08,.4,1] for f in [-1,0,1]],False)
    else:
        for f in field(original,'keyforms'):deep(f,'opacity').text='0.0'
    field(main,'name').text=character+' nine-direction talking v1'
    # Remove unreachable donor records, including its original standalone model.
    owners={e.get('xs.id'):top for top in shared for e in top.iter() if e.get('xs.id')};pending=[e.get('xs.ref') for e in main.iter() if e.get('xs.ref')];keep=set()
    while pending:
        ref=pending.pop();assert ref in owners,ref;top=owners[ref]
        if id(top) in keep:continue
        keep.add(id(top));pending.extend(e.get('xs.ref') for e in top.iter() if e.get('xs.ref'))
    for e in list(shared):
        if id(e) not in keep:shared.remove(e)
    lookup={e.get('xs.id'):e for e in root.iter() if e.get('xs.id')}
    assert len(lookup)==len([e for e in root.iter() if e.get('xs.id')])
    for e in root.iter():
        if e.get('xs.ref'):assert e.get('xs.ref') in lookup and lookup[e.get('xs.ref')].tag==e.tag,(e.tag,e.attrib)
    report['mouthMeshes']=[{'name':name(e),'forms':len(field(e,'keyforms'))} for e in added]
    report['changedSourceObjects']=[name(e) if e.tag in ['CArtMeshSource','CWarpDeformerSource'] else e.tag for e in shared if e.get('xs.id') in before and E.tostring(e)!=before[e.get('xs.id')]]
    report['originalMouthId']=resolve(deep(original,'id')).get('idstr')
    report['newMouthIds']=[resolve(deep(e,'id')).get('idstr') for e in added]
    report['pipelineVersion']='pro-rig-v2-mouth-orientation'
    output.write_bytes(H['repack'](header,key,entries,root));output.with_suffix('.integration.json').write_text(json.dumps(report,ensure_ascii=False,indent=2));print(output)

if __name__=='__main__':build(sys.argv[1],*map(Path,sys.argv[2:5]))

