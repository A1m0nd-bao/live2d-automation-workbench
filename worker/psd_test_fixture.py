import io
from PIL import Image, ImageDraw
from psd_tools import PSDImage
from psd_tools.api.layers import PixelLayer


def layered_psd():
    psd = PSDImage.new('RGBA', (32,32))
    for name,box,color in [('handwear-r',(3,8,8,23),(160,100,60,128)),
                           ('topwear',(8,8,24,28),(30,40,80,255))]:
        image=Image.new('RGBA',psd.size)
        ImageDraw.Draw(image).rectangle(box,fill=color)
        PixelLayer.frompil(image,psd,name)
    stream=io.BytesIO()
    psd.save(stream)
    return stream.getvalue()
