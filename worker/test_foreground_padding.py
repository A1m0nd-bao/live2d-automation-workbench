import importlib.util
import tempfile
import types
import unittest
from pathlib import Path
from unittest.mock import patch

from PIL import Image

spec = importlib.util.spec_from_file_location('fg', Path(__file__).parent / 'app/foreground.py')
fg = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fg)


class PaddingTests(unittest.TestCase):
    def test_padding_preserves_foreground_pixels_and_legacy_dimensions(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = Image.new('RGBA', (32, 48), (10, 20, 30, 255))
            source.save(root / 'source.png')
            mask = Image.new('L', source.size)
            mask.paste(255, (10, 10, 22, 38))
            fake = types.SimpleNamespace(new_session=lambda *a, **kw: types.SimpleNamespace(predict=lambda image: [mask]))
            with patch.dict('sys.modules', {'rembg': fake}):
                fg.process(root / 'source.png', root / 'legacy')
                report = fg.process(root / 'source.png', root / 'padded', .125)
            with Image.open(root / 'legacy/foreground.png') as old, Image.open(root / 'padded/foreground.png') as new:
                self.assertEqual(old.size, (32, 48))
                self.assertEqual(new.size, (40, 60))
                self.assertEqual(new.getpixel((14, 16)), source.getpixel((10, 10)))
                self.assertEqual(new.getpixel((0, 0))[3], 0)
                self.assertEqual(new.crop((4, 6, 36, 54)).tobytes(), old.tobytes())
            self.assertEqual(report['padding'], [4, 6])
