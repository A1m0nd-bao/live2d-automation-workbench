"""Non-generative anime cutout. Original pixels/coordinates are preserved."""
import argparse
import hashlib
import json
from pathlib import Path


def process(source, output):
    import numpy as np
    from PIL import Image, ImageOps
    from rembg import new_session

    output = Path(output)
    output.mkdir(parents=True, exist_ok=True)
    original = ImageOps.exif_transpose(Image.open(source)).convert("RGBA")
    # Transparent browser padding must not be presented as black to the model.
    rgb = Image.alpha_composite(Image.new("RGBA", original.size, "white"), original).convert("RGB")
    session = new_session("isnet-anime", providers=["CPUExecutionProvider"])
    mask = session.predict(rgb)[0]
    alpha = np.minimum(np.asarray(mask), np.asarray(original.getchannel("A")))
    visible = alpha > 16
    coverage = float(visible.mean())
    if not 0.02 < coverage < 0.90:
        raise ValueError(f"Foreground coverage {coverage:.3f} is suspicious; upstream submission blocked")
    ys, xs = np.where(visible)
    bounds = [int(xs.min()), int(ys.min()), int(xs.max()+1), int(ys.max()+1)]
    # Do not claim that a numerical mask check can verify anatomy or accessories.
    report = {"model": "isnet-anime", "source_sha256": hashlib.sha256(Path(source).read_bytes()).hexdigest(),
              "size": list(original.size), "visible_fraction": coverage, "alpha_bounds": bounds,
              "qa": "numeric_only; inspect halo, wings, fingers and dress visually"}
    foreground = original.copy()
    foreground.putalpha(Image.fromarray(alpha))
    foreground.save(output / "foreground.png")
    Image.fromarray(alpha).save(output / "mask.png")
    # Solid neutral gray is explicit: upstream image decoders may discard alpha.
    submission = Image.alpha_composite(Image.new("RGBA", original.size, (208,208,208,255)), foreground).convert("RGB")
    submission.save(output / "submission.png")
    Image.alpha_composite(Image.new("RGBA", original.size, (40,48,62,255)), foreground).convert("RGB").save(output / "on-dark.png")
    (output / "report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2))
    return report


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("source")
    parser.add_argument("output")
    args = parser.parse_args()
    print(json.dumps(process(args.source, args.output)))
