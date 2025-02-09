export interface FileType {
    _id: string;
    filename: string;
    contentType: string;
    uploadDate: string;
    length: number;
    metadata?: {
        userID: string;
        originalname?: string;
        sanitizedFilename?: string;
        size?: number;
        uploadDate?: string;
    };
}

export interface FileSelectorModalProps {
    visible: boolean;
    onClose: () => void;
    onSelect: (files: FileType[]) => void;
    options?: {
        fileTypeFilter?: string[];
        maxFiles?: number;
    };
}

export interface UseFilesOptions {
    fileTypeFilter?: string[];
    maxFiles?: number;
    userId?: string;
}

export interface FileItemProps {
    file: FileType;
    isSelected: boolean;
    onSelect: (file: FileType) => void;
    onDelete: (fileId: string) => void;
    baseUrl: string;
}