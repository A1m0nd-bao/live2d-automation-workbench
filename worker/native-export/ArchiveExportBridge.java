package autolive2d.bridge;

import com.live2d.cubism.doc.model.CModelSource;
import com.live2d.cubism.doc.model.exporter.CMocExportSetting;
import com.live2d.cubism.doc.model.exporter.CModelExportSettingDialogData;
import com.live2d.cubism.doc.model.exporter.dD;
import com.live2d.cubism.doc.model.exporter.w;
import com.live2d.graphics.filter.CubismStaticFilterLibrary;
import com.live2d.serialize.XmlReader;
import com.live2d.serialize.archiver.ArchiveFormat;
import com.live2d.serialize.archiver.ArchiveReader;
import com.live2d.type.CArrayList;
import java.io.ByteArrayInputStream;
import java.io.File;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Arrays;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.jdom.Document;
import org.jdom.input.SAXBuilder;

public final class ArchiveExportBridge {
  public static void main(String[] args) {
    Map<String, Object> result = new LinkedHashMap<>();
    String archivePath = args.length > 0 ? args[0] : "";
    String outputMoc3Path = args.length > 1 ? args[1] : "";
    String progressPath = args.length > 2 ? args[2] : "";

    result.put("status", "error");
    result.put("vendorDir", "");
    result.put("manifestPath", "");
    result.put("archivePath", archivePath);
    result.put("outputMoc3Path", outputMoc3Path);
    result.put("javaVersion", System.getProperty("java.version", ""));
    result.put("mainXmlTag", ArchiveFormat.INSTANCE.getTAG_MAIN_XML());
    result.put("mainXmlPaths", List.of());
    result.put("moc3Written", false);
    result.put("progressPath", progressPath);

    try {
      File archiveFile = new File(archivePath);
      File outputFile = new File(outputMoc3Path);
      outputFile.getParentFile().mkdirs();

      writeStage(progressPath, "open-archive");
      System.err.println("stage: open-archive");
      ArchiveReader archiveReader = new ArchiveReader(archiveFile);
      CubismStaticFilterLibrary.INSTANCE.initFilter();
      String mainXmlTag = ArchiveFormat.INSTANCE.getTAG_MAIN_XML();
      String[] mainXmlPaths = archiveReader.getTaggedFilePath(mainXmlTag);
      result.put("mainXmlPaths", Arrays.asList(mainXmlPaths));

      writeStage(progressPath, "load-main-xml");
      System.err.println("stage: load-main-xml");
      byte[] mainXmlBytes = archiveReader.getFirstFileByTag(mainXmlTag);
      if (mainXmlBytes == null || mainXmlBytes.length == 0) {
        throw new IllegalStateException("Archive did not expose a main XML payload.");
      }

      writeStage(progressPath, "parse-main-xml");
      System.err.println("stage: parse-main-xml");
      SAXBuilder saxBuilder = new SAXBuilder();
      saxBuilder.setFeature("http://apache.org/xml/features/disallow-doctype-decl", true);
      saxBuilder.setFeature("http://xml.org/sax/features/external-general-entities", false);
      saxBuilder.setFeature("http://xml.org/sax/features/external-parameter-entities", false);
      Document document = saxBuilder.build(new ByteArrayInputStream(mainXmlBytes));
      XmlReader xmlReader = new XmlReader(archiveReader, new java.util.HashMap<>());
      CArrayList<String> imports = new CArrayList<>();
      for (Object content : document.getContent()) {
        if (content instanceof org.jdom.ProcessingInstruction) {
          xmlReader.parse_ProcessingInstruction((org.jdom.ProcessingInstruction) content, imports);
        }
      }
      writeStage(progressPath, "deserialize-root");
      System.err.println("stage: deserialize-root");
      Object rootObject = xmlReader.readRootObject(document.getRootElement());
      result.put("rootClass", rootObject == null ? "" : rootObject.getClass().getName());

      writeStage(progressPath, "resolve-model-source");
      System.err.println("stage: resolve-model-source");
      CModelSource modelSource = resolveModelSource(rootObject);
      if (modelSource == null) {
        throw new IllegalStateException("Unable to resolve CModelSource from archive root.");
      }
      result.put("modelSourceClass", modelSource.getClass().getName());
      result.put("sourceMeshes", modelSource.getAllArtMeshes().size());
      result.put("sourceDeformers", modelSource.getAllDeformers().size());
      modelSource.setup();
      result.put("sourceParameters", modelSource.getAllParameters().size());
      prepareAtlases(modelSource);
      result.put("atlasCount", modelSource.getTextureManager().getTextureAtlases().size());
      result.put("modelImageCount", modelSource.getTextureManager().getAllModelImages().size());
      result.put("atlasBoundMeshes", modelSource.getAllArtMeshes().stream().filter(m -> m.getTextureInputExtension() != null && m.getTextureInputExtension().getTextureAtlasInput() != null && m.getTextureInputExtension().getTextureAtlasInput().getTextureAtlasGuid() != null).count());

      writeStage(progressPath, "build-export-settings");
      System.err.println("stage: build-export-settings");
      CModelExportSettingDialogData dialogData = new CModelExportSettingDialogData();
      dialogData.setup(modelSource);
      dialogData.setExportInvisiblePart(true);
      dialogData.setExportSketchPart(true);
      dialogData.setExportInvisibleArtMesh(true);
      CMocExportSetting mocExportSetting = dialogData.toMocSetting();
      w exporter = new w();
      exporter.a(mocExportSetting);
      writeStage(progressPath, "export-moc");
      System.err.println("stage: export-moc");
      dD exportResult = exporter.a(modelSource, null);

      writeStage(progressPath, "write-moc");
      System.err.println("stage: write-moc");
      byte[] mocBytes = toByteArray(exportResult.a());
      Files.write(outputFile.toPath(), mocBytes);
      result.put("textureCount", exportResult.b().size());
      for (int i = 0; i < exportResult.b().size(); i++) {
        exportResult.b().get(i).getImage().writeImage(new File(outputFile.getParentFile(), "texture_" + i + ".png"));
      }
      result.put("consistency", com.live2d.sdk.cubism.core.Live2DCubismCore.hasMocConsistency(mocBytes));
      try (var moc = com.live2d.sdk.cubism.core.CubismMoc.instantiate(mocBytes); var runtime = moc.instantiateModel()) {
        result.put("runtimeMeshes", runtime.getDrawableViews().length);
        result.put("runtimeParameters", runtime.getParameterViews().length);
        result.put("runtimeDeformers", runtime.getDeformerViews().length);
        var sweeps = new java.util.ArrayList<Object>();
        for (var p : runtime.getParameterViews()) {
          for (var q : runtime.getParameterViews()) q.setValue(q.getDefaultValue());
          p.setValue(p.getMinimumValue()); runtime.update();
          var before = new java.util.ArrayList<float[]>();
          for (var d : runtime.getDrawableViews()) before.add(d.getVertexPositions().clone());
          p.setValue(p.getMaximumValue()); runtime.update();
          double maxDelta = 0; int changed = 0;
          for (var d : runtime.getDrawableViews()) {
            double delta = 0; var a = before.get(d.getIndex()); var b = d.getVertexPositions();
            for (int j = 0; j < b.length; j++) { if (!Float.isFinite(b[j])) throw new IllegalStateException("Nonfinite vertex"); delta = Math.max(delta, Math.abs(b[j] - a[j])); }
            if (delta > 1e-7) changed++;
            maxDelta = Math.max(maxDelta, delta);
          }
          sweeps.add(Map.of("id", p.getId(), "min", p.getMinimumValue(), "max", p.getMaximumValue(), "changedMeshes", changed, "maxVertexDelta", maxDelta));
        }
        result.put("parameterSweeps", sweeps);
        if (runtime.getDrawableViews().length != modelSource.getAllArtMeshes().size() || exportResult.b().isEmpty()) throw new IllegalStateException("Incomplete runtime export");
      }

      result.put("status", "ok");
      result.put("moc3Written", true);
      result.put("moc3Size", mocBytes.length);
      writeStage(progressPath, "done");
    } catch (Throwable error) {
      error.printStackTrace();
      Throwable root = unwrap(error);
      result.put("error", rootMessage(root));
      writeStage(progressPath, "error: " + rootMessage(root));
    }

    System.out.println(toJson(result));
    try { Files.writeString(Path.of(outputMoc3Path + ".report.json"), toJson(result)); } catch (Exception ignored) {}
    System.exit("ok".equals(result.get("status")) ? 0 : 1);
  }

  private static CModelSource resolveModelSource(Object rootObject) throws Exception {
    if (rootObject == null) {
      return null;
    }
    if (rootObject instanceof CModelSource) {
      return (CModelSource) rootObject;
    }

    try {
      Object value = rootObject.getClass().getMethod("getModelSource").invoke(rootObject);
      if (value instanceof CModelSource) {
        return (CModelSource) value;
      }
    } catch (NoSuchMethodException ignored) {
    }
    return null;
  }

  private static void prepareAtlases(CModelSource model) {
    var manager = model.getTextureManager();
    if (manager.getTextureAtlases().isEmpty()) {
      // One original-resolution image per atlas for the first fidelity probe.
      // No mesh/keyform edits and no image resampling.
      int i = 0;
      for (var image : manager.getAllModelImages()) {
        int size = 1;
        while (size < Math.max(image.getWidth(), image.getHeight()) + 8) size *= 2;
        if (size > 8192) throw new IllegalStateException("Atlas too large");
        var atlas = new com.live2d.cubism.doc.model.texture.textureAtlas.CTextureAtlas(model, "texture_" + i++, size, size);
        manager.addTextureAtlas(atlas, -1);
        var transform = new com.live2d.type.CAffine();
        transform.translate(4f, 4f);
        var entry = new com.live2d.cubism.doc.model.texture.textureAtlas.CTextureAtlas.ModelImageEntry(atlas, image.getGuid(), transform);
        entry.setup();
        atlas.getModelImages().add(entry);
      }
    }
    manager.changeModelTextureInput_toAtlas();
    manager.getHandler().h();
    for (var mesh : model.getAllArtMeshes()) {
      var input = mesh.getTextureInputExtension();
      if (input != null && input.getTextureAtlasInput() != null && input.getTextureAtlasInput().getTextureAtlasGuid() != null)
        mesh.setTextureState(com.live2d.cubism.doc.model.drawable.TextureState.TEXTURE_ATLAS);
    }
  }

  private static byte[] toByteArray(List<Byte> bytes) {
    byte[] buffer = new byte[bytes.size()];
    for (int index = 0; index < bytes.size(); index += 1) {
      buffer[index] = bytes.get(index);
    }
    return buffer;
  }

  private static void writeStage(String progressPath, String stage) {
    if (progressPath == null || progressPath.isBlank()) {
      return;
    }
    try {
      Files.writeString(Path.of(progressPath), stage);
    } catch (Throwable ignored) {
    }
  }

  private static Throwable unwrap(Throwable error) {
    if (error instanceof java.lang.reflect.InvocationTargetException) {
      Throwable cause = ((java.lang.reflect.InvocationTargetException) error).getTargetException();
      return cause == null ? error : cause;
    }
    return error;
  }

  private static String rootMessage(Throwable error) {
    Throwable current = error;
    while (current.getCause() != null && current.getCause() != current) {
      current = current.getCause();
    }
    String message = current.getMessage();
    return message == null || message.isBlank()
      ? current.getClass().getName()
      : current.getClass().getName() + ": " + message;
  }

  private static String toJson(Object value) {
    if (value == null) {
      return "null";
    }
    if (value instanceof String) {
      return "\"" + escape((String) value) + "\"";
    }
    if (value instanceof Number || value instanceof Boolean) {
      return String.valueOf(value);
    }
    if (value instanceof Map) {
      StringBuilder builder = new StringBuilder();
      builder.append("{");
      boolean first = true;
      for (Object entryObject : ((Map<?, ?>) value).entrySet()) {
        Map.Entry<?, ?> entry = (Map.Entry<?, ?>) entryObject;
        if (!first) {
          builder.append(",");
        }
        first = false;
        builder.append(toJson(String.valueOf(entry.getKey())));
        builder.append(":");
        builder.append(toJson(entry.getValue()));
      }
      builder.append("}");
      return builder.toString();
    }
    if (value instanceof Iterable) {
      StringBuilder builder = new StringBuilder();
      builder.append("[");
      boolean first = true;
      for (Object item : (Iterable<?>) value) {
        if (!first) {
          builder.append(",");
        }
        first = false;
        builder.append(toJson(item));
      }
      builder.append("]");
      return builder.toString();
    }
    return toJson(String.valueOf(value));
  }

  private static String escape(String value) {
    return value
      .replace("\\", "\\\\")
      .replace("\"", "\\\"")
      .replace("\r", "\\r")
      .replace("\n", "\\n")
      .replace("\t", "\\t");
  }
}
