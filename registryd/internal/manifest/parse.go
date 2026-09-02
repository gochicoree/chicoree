// Package manifest parses OCI image manifests, OCI image indexes and their
// Docker schema2 equivalents just deeply enough to validate references and
// extract metadata. Payload bytes are always preserved verbatim; digests are
// computed over the exact bytes the client sent.
package manifest

import (
	"encoding/json"
	"fmt"
	"strings"
)

// Well-known media types.
const (
	MediaTypeOCIManifest    = "application/vnd.oci.image.manifest.v1+json"
	MediaTypeOCIIndex       = "application/vnd.oci.image.index.v1+json"
	MediaTypeDockerManifest = "application/vnd.docker.distribution.manifest.v2+json"
	MediaTypeDockerList     = "application/vnd.docker.distribution.manifest.list.v2+json"
)

// Descriptor is an OCI content descriptor.
type Descriptor struct {
	MediaType    string            `json:"mediaType"`
	Digest       string            `json:"digest"`
	Size         int64             `json:"size"`
	ArtifactType string            `json:"artifactType,omitempty"`
	Platform     *Platform         `json:"platform,omitempty"`
	Annotations  map[string]string `json:"annotations,omitempty"`
}

// Platform identifies an os/arch variant inside an index.
type Platform struct {
	Architecture string `json:"architecture"`
	OS           string `json:"os"`
	Variant      string `json:"variant,omitempty"`
}

// Parsed is the normalized result of parsing a manifest payload.
type Parsed struct {
	MediaType    string
	ArtifactType string
	IsIndex      bool
	Config       *Descriptor  // image manifests only
	Layers       []Descriptor // image manifests only
	Children     []Descriptor // indexes only
	Subject      *Descriptor
	Annotations  map[string]string
}

type rawManifest struct {
	SchemaVersion int               `json:"schemaVersion"`
	MediaType     string            `json:"mediaType"`
	ArtifactType  string            `json:"artifactType"`
	Config        *Descriptor       `json:"config"`
	Layers        []Descriptor      `json:"layers"`
	Manifests     []Descriptor      `json:"manifests"`
	Subject       *Descriptor       `json:"subject"`
	Annotations   map[string]string `json:"annotations"`
}

// IsForeignLayer reports whether a layer is external to the registry and thus
// exempt from existence checks.
func IsForeignLayer(mediaType string) bool {
	return strings.Contains(mediaType, "foreign") || strings.Contains(mediaType, "nondistributable")
}

// Parse validates the payload against the declared content type.
func Parse(contentType string, payload []byte) (*Parsed, error) {
	var raw rawManifest
	if err := json.Unmarshal(payload, &raw); err != nil {
		return nil, fmt.Errorf("manifest is not valid JSON: %w", err)
	}
	mediaType := contentType
	if i := strings.IndexByte(mediaType, ';'); i >= 0 {
		mediaType = strings.TrimSpace(mediaType[:i])
	}
	if mediaType == "" || mediaType == "application/json" || mediaType == "application/octet-stream" {
		mediaType = raw.MediaType
	}
	if raw.MediaType != "" && mediaType != raw.MediaType {
		return nil, fmt.Errorf("content type %q does not match manifest mediaType %q", mediaType, raw.MediaType)
	}

	p := &Parsed{MediaType: mediaType, ArtifactType: raw.ArtifactType, Subject: raw.Subject, Annotations: raw.Annotations}
	switch mediaType {
	case MediaTypeOCIIndex, MediaTypeDockerList:
		p.IsIndex = true
		p.Children = raw.Manifests
		for _, c := range p.Children {
			if err := validateDescriptor(&c); err != nil {
				return nil, err
			}
		}
	case MediaTypeOCIManifest, MediaTypeDockerManifest:
		if raw.Config == nil {
			return nil, fmt.Errorf("manifest has no config descriptor")
		}
		if err := validateDescriptor(raw.Config); err != nil {
			return nil, err
		}
		p.Config = raw.Config
		p.Layers = raw.Layers
		for _, l := range p.Layers {
			if err := validateDescriptor(&l); err != nil {
				return nil, err
			}
		}
		// artifactType falls back to the config media type for OCI artifacts.
		if p.ArtifactType == "" && raw.Config.MediaType != "application/vnd.oci.image.config.v1+json" &&
			raw.Config.MediaType != "application/vnd.docker.container.image.v1+json" {
			p.ArtifactType = raw.Config.MediaType
		}
	default:
		return nil, fmt.Errorf("unsupported manifest media type %q", mediaType)
	}
	if p.Subject != nil {
		if err := validateDescriptor(p.Subject); err != nil {
			return nil, err
		}
	}
	return p, nil
}

func validateDescriptor(d *Descriptor) error {
	if d.Digest == "" || !strings.Contains(d.Digest, ":") {
		return fmt.Errorf("descriptor has invalid digest %q", d.Digest)
	}
	if d.MediaType == "" {
		return fmt.Errorf("descriptor %s has no mediaType", d.Digest)
	}
	return nil
}

// References returns every digest this manifest points at (config, layers,
// child manifests) excluding foreign layers and the subject.
func (p *Parsed) References() []string {
	var refs []string
	if p.Config != nil {
		refs = append(refs, p.Config.Digest)
	}
	for _, l := range p.Layers {
		if !IsForeignLayer(l.MediaType) {
			refs = append(refs, l.Digest)
		}
	}
	for _, c := range p.Children {
		refs = append(refs, c.Digest)
	}
	return refs
}
